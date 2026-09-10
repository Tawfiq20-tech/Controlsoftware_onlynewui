/**
 * ChatbotService — local Onefinity/EasyCNC assistant.
 *
 * No Python, no MongoDB, no separate process. Runs inside the same Node
 * backend that already has command authority over the machine (port 4000).
 *
 * Offline mode: keyword-overlap retrieval over bundled docs (always works).
 * Online mode: if GROQ_API_KEY is set and the Groq API is reachable, the
 * retrieved context is handed to the LLM for a nicer-worded answer. Any
 * failure (no key, network error, timeout) falls back to the offline answer
 * — the user always gets a response.
 *
 * This service NEVER touches the machine. It only reports a suggested
 * action name; the frontend decides whether/how to execute it via the same
 * functions the existing UI buttons already call.
 */
const fs = require('fs');
const path = require('path');
const logger = require('../../logger');

const DOCS_DIR = path.join(__dirname, 'docs');
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.1-8b-instant';
const GROQ_TIMEOUT_MS = 8000;

const STOPWORDS = new Set([
    'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'to', 'of',
    'in', 'on', 'for', 'and', 'or', 'it', 'my', 'i', 'do', 'does', 'did',
    'how', 'what', 'why', 'when', 'can', 'you', 'me', 'this', 'that', 'with',
]);

function tokenize(text) {
    const words = String(text)
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 1);
    const stripped = words.filter((w) => !STOPWORDS.has(w));
    // Short phrases built entirely from stopwords (e.g. "what can you do")
    // would otherwise tokenize to nothing and score 0 against every entry,
    // including their own exact-match QA pair. Fall back to the unfiltered
    // words so an exact phrase can still match itself.
    return stripped.length > 0 ? stripped : words;
}

// Dice coefficient (2*overlap / sum of lengths) rather than plain recall —
// this prefers a short, direct question match over a longer tangential one
// that happens to contain the same keywords.
function overlapScore(queryTokens, targetTokens) {
    if (queryTokens.length === 0 || targetTokens.length === 0) return 0;
    const targetSet = new Set(targetTokens);
    let hits = 0;
    for (const t of queryTokens) if (targetSet.has(t)) hits += 1;
    return (2 * hits) / (queryTokens.length + targetTokens.length);
}

// Jog is the one parameterized action allowed to auto-execute (v1.1): axis,
// direction, and distance are pulled out of free text below, clamped to the
// same range the manual jog UI offers (Sidebar.tsx distance presets 0.1-100mm,
// speed presets 600-10000mm/min, default 1000mm/min per jogSpeedStorage), and
// the frontend confirm-tap always shows the exact resolved command before it
// ever reaches backendJog() -- see plan_chatbot_and_remote_access.md addendum.
// probe/job_start still need context (which strategy, which loaded file) chat
// text can't safely supply, so they stay guide-only.
const JOG_MIN_DISTANCE_MM = 0.1;
const JOG_MAX_DISTANCE_MM = 100;
const JOG_MIN_FEED = 10;
const JOG_MAX_FEED = 10000;
const JOG_DEFAULT_FEED = 1000; // matches jogSpeedStorage's default (localStorage.ts)

// axis + sign implied by a direction word, so "nudge Z up 2" and "jog up 2mm"
// work without the operator ever typing a bare axis letter.
const DIRECTION_WORDS = {
    up: { axis: 'z', sign: 1 },
    down: { axis: 'z', sign: -1 },
    left: { axis: 'x', sign: -1 },
    right: { axis: 'x', sign: 1 },
    forward: { axis: 'y', sign: 1 },
    forwards: { axis: 'y', sign: 1 },
    back: { axis: 'y', sign: -1 },
    backward: { axis: 'y', sign: -1 },
    backwards: { axis: 'y', sign: -1 },
};

const JOG_INTENT_RE = new RegExp(
    `\\bjog\\b|\\bnudge\\b|\\b(move|shift)\\b.*\\b(x|y|z|${Object.keys(DIRECTION_WORDS).join('|')})\\b`
);

function formatNum(n) {
    return Number(n.toFixed(2)).toString();
}

// Returns { ok: true, axis, distance, feedRate } on a clean parse, or
// { ok: false, reason } when the axis or distance is ambiguous -- callers
// must surface `reason` as a clarifying question rather than guessing.
function parseJogCommand(text) {
    const q = text.toLowerCase();

    let axis = null;
    let sign = 1;
    for (const [word, dir] of Object.entries(DIRECTION_WORDS)) {
        if (new RegExp(`\\b${word}\\b`).test(q)) { axis = dir.axis; sign = dir.sign; break; }
    }
    if (!axis) {
        const axisMatch = q.match(/\b([xyz])\b/);
        if (axisMatch) axis = axisMatch[1];
    }
    if (!axis) {
        return { ok: false, reason: 'Which axis? Tell me X, Y, or Z (e.g. "jog X 10mm").' };
    }

    // Explicit sign overrides a direction word's implied sign.
    if (/-\s*\d/.test(q) || /\bminus\b|\bnegative\b/.test(q)) sign = -1;
    else if (/\bplus\b|\bpositive\b/.test(q)) sign = 1;

    // Prefer a number explicitly tagged "mm"; otherwise take the first bare
    // number that isn't part of a feed-rate phrase (e.g. "@1000" or "at 1000").
    let distance = null;
    const mmMatch = q.match(/(\d+(?:\.\d+)?)\s*mm\b/);
    if (mmMatch) {
        distance = parseFloat(mmMatch[1]);
    } else {
        const feedPhrase = /(?:@|\bat\b|\bfeed(?:\s*rate)?\b)\s*\d+(?:\.\d+)?/;
        const numMatch = q.replace(feedPhrase, '').match(/(\d+(?:\.\d+)?)/);
        if (numMatch) distance = parseFloat(numMatch[1]);
    }
    if (distance === null || distance === 0) {
        return {
            ok: false,
            reason: `How far should I jog ${axis.toUpperCase()}? Give me a distance in mm (e.g. "jog ${axis.toUpperCase()} 10mm").`,
        };
    }
    distance = Math.min(Math.max(Math.abs(distance), JOG_MIN_DISTANCE_MM), JOG_MAX_DISTANCE_MM) * sign;

    let feedRate = JOG_DEFAULT_FEED;
    const feedMatch = q.match(/(?:@|\bat\b|\bfeed(?:\s*rate)?\b)\s*(\d+(?:\.\d+)?)/);
    if (feedMatch) {
        feedRate = Math.min(Math.max(parseFloat(feedMatch[1]), JOG_MIN_FEED), JOG_MAX_FEED);
    }

    return { ok: true, axis, distance: Math.round(distance * 100) / 100, feedRate: Math.round(feedRate) };
}

// v1 allowlist: home/unlock/job_pause/job_resume/job_stop are parameter-free
// (nothing to get wrong), jog is parameterized but clamped + confirm-gated
// (see above), probe/job_start remain guide-only.
const ACTION_PATTERNS = [
    { action: 'home', label: 'Home all axes', autoExec: true, re: /\bhome\b|\bhoming\b/ },
    { action: 'unlock', label: 'Clear the alarm', autoExec: true, re: /\bclear\b.*\balarm\b|\bunlock\b|\breset\b.*\balarm\b/ },
    { action: 'job_pause', label: 'Pause the job', autoExec: true, re: /\bpause\b/ },
    { action: 'job_resume', label: 'Resume the job', autoExec: true, re: /\bresume\b|\bcontinue\b.*\bjob\b/ },
    { action: 'job_stop', label: 'Stop the job', autoExec: true, re: /\bstop\b.*\bjob\b|\babort\b/ },
    { action: 'jog', label: 'Jog an axis', autoExec: false, re: JOG_INTENT_RE },
    { action: 'probe', label: 'Run a probe cycle', autoExec: false, re: /\bprobe\b|\btouch.?plate\b/ },
    { action: 'job_start', label: 'Start the loaded job', autoExec: false, re: /\bstart\b.*\bjob\b|\brun\b.*\b(gcode|g-code|file)\b/ },
];

function detectAction(query) {
    const q = query.toLowerCase();
    for (const p of ACTION_PATTERNS) {
        if (!p.re.test(q)) continue;
        if (p.action === 'jog') {
            const parsed = parseJogCommand(query);
            if (!parsed.ok) {
                return { action: 'jog', label: p.label, autoExec: false, clarification: parsed.reason };
            }
            const sign = parsed.distance < 0 ? '-' : '+';
            return {
                action: 'jog',
                label: `Jog ${parsed.axis.toUpperCase()} ${sign}${formatNum(Math.abs(parsed.distance))}mm @ ${parsed.feedRate}mm/min`,
                autoExec: true,
                params: { axis: parsed.axis, distance: parsed.distance, feedRate: parsed.feedRate },
            };
        }
        return { action: p.action, label: p.label, autoExec: p.autoExec };
    }
    return null;
}

class ChatbotService {
    constructor() {
        this.qaPairs = [];      // { question, answer }
        this.errorEntries = []; // { key, means, fix, nav }
        this.docChunks = [];    // { text, source }
        this._loadDocs();
        logger.info(
            `[Chatbot] loaded ${this.qaPairs.length} QA pairs, ${this.errorEntries.length} error entries, ${this.docChunks.length} doc chunks`
        );
    }

    _loadDocs() {
        this._loadQaJsonl(path.join(DOCS_DIR, 'control_software_qa.jsonl'));
        this._loadErrorKb(path.join(DOCS_DIR, 'serial_error_kb.txt'));
        this._loadMarkdown(path.join(DOCS_DIR, 'onefinity-control-navigation.md'), 'navigation guide');
        this._loadMarkdown(path.join(DOCS_DIR, 'ONEFINITY_WEBSITE_KNOWLEDGE_BASE.md'), 'general knowledge base');
    }

    _loadQaJsonl(file) {
        if (!fs.existsSync(file)) return;
        const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
        for (const line of lines) {
            try {
                const obj = JSON.parse(line);
                if (obj.question && obj.answer) {
                    // Tokenize once at load time instead of on every query --
                    // this list is re-scanned in full for every chat message.
                    obj.questionTokens = tokenize(obj.question);
                    this.qaPairs.push(obj);
                }
            } catch (_) { /* skip malformed line */ }
        }
    }

    _loadErrorKb(file) {
        if (!fs.existsSync(file)) return;
        const text = fs.readFileSync(file, 'utf8');
        const blocks = text.split(/--- Entry \d+ ---/).slice(1);
        for (const block of blocks) {
            const key = /KEY:\s*(.+)/.exec(block);
            const means = /MEANS:\s*(.+)/.exec(block);
            const fix = /FIX:\s*(.+)/.exec(block);
            const nav = /NAV:\s*(.+)/.exec(block);
            if (key && fix) {
                const keyStr = key[1].trim();
                this.errorEntries.push({
                    key: keyStr,
                    keyTokens: tokenize(keyStr),
                    means: means ? means[1].trim() : '',
                    fix: fix[1].trim(),
                    nav: nav ? nav[1].trim() : '',
                });
            }
        }
    }

    _loadMarkdown(file, sourceName) {
        if (!fs.existsSync(file)) return;
        const text = fs.readFileSync(file, 'utf8');
        const sections = text.split(/\n(?=#{1,3}\s)/);
        for (const section of sections) {
            const trimmed = section.trim();
            if (trimmed.length > 40) {
                const chunkText = trimmed.slice(0, 1200);
                this.docChunks.push({ text: chunkText, textTokens: tokenize(chunkText), source: sourceName });
            }
        }
    }

    // Returns { answer, sources, score } — the best offline match, or a
    // generic "don't know" if nothing scores above threshold. Uses the
    // tokens cached at load time (_loadQaJsonl/_loadErrorKb/_loadMarkdown)
    // instead of re-tokenizing all ~560 entries on every single query.
    _retrieve(query) {
        const qTokens = tokenize(query);
        let best = null;

        for (const kb of this.errorEntries) {
            const score = overlapScore(qTokens, kb.keyTokens);
            if (!best || score > best.score) {
                best = {
                    score,
                    answer: `${kb.means ? kb.means + ' ' : ''}${kb.fix}${kb.nav ? ` (Where: ${kb.nav})` : ''}`,
                    sources: ['serial_error_kb.txt'],
                };
            }
        }

        for (const qa of this.qaPairs) {
            const score = overlapScore(qTokens, qa.questionTokens);
            if (!best || score > best.score) {
                best = { score, answer: qa.answer, sources: ['control_software_qa.jsonl'] };
            }
        }

        for (const chunk of this.docChunks) {
            const score = overlapScore(qTokens, chunk.textTokens) * 0.7; // prose chunks are noisier, downweight
            if (!best || score > best.score) {
                best = { score, answer: chunk.text, sources: [chunk.source] };
            }
        }

        return best;
    }

    _offlineAnswer(best) {
        if (!best || best.score < 0.2) {
            return {
                answer:
                    "I don't have documentation matching that. Try asking about homing, jogging, probing, alarms, connecting, or a specific error message you're seeing.",
                sources: [],
                usedOnline: false,
            };
        }
        return { answer: best.answer, sources: best.sources, usedOnline: false };
    }

    async _onlineAnswer(query, history, machineContext, best) {
        const apiKey = process.env.GROQ_API_KEY;
        if (!apiKey) return null;

        const context = best && best.score >= 0.15 ? best.answer : '';
        const stateLine = machineContext
            ? `\n\nCurrent machine state (for reference only, do not repeat verbatim unless asked): ` +
              `state=${machineContext.state ?? 'unknown'}, connected=${machineContext.connected ?? 'unknown'}, ` +
              `loadedFile=${machineContext.loadedFile ?? 'none'}, lastError=${machineContext.lastError ?? 'none'}`
            : '';

        const messages = [
            {
                role: 'system',
                content:
                    'You are the EasyCNC/Onefinity control-software assistant. Answer briefly and concretely, ' +
                    'grounded in the provided context when given. If the context does not cover the question, ' +
                    'say you are not certain rather than guessing at machine-specific behavior. Never claim you ' +
                    'can perform an action yourself — the app will offer a confirm button separately if relevant.' +
                    (context ? `\n\nRelevant documentation:\n${context}` : '') +
                    stateLine,
            },
            ...(Array.isArray(history) ? history.slice(-6) : []),
            { role: 'user', content: query },
        ];

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), GROQ_TIMEOUT_MS);
        try {
            const res = await fetch(GROQ_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
                body: JSON.stringify({ model: GROQ_MODEL, messages, temperature: 0.3, max_tokens: 400 }),
                signal: controller.signal,
            });
            if (!res.ok) throw new Error(`Groq ${res.status}`);
            const data = await res.json();
            const answer = data.choices?.[0]?.message?.content;
            if (!answer) throw new Error('Groq returned no answer');
            return { answer, sources: best ? best.sources : [], usedOnline: true };
        } catch (err) {
            logger.warn(`[Chatbot] online answer failed, falling back offline: ${err.message}`);
            return null;
        } finally {
            clearTimeout(timeout);
        }
    }

    // High-confidence threshold for skipping the Groq round-trip entirely.
    // A score this strong means we already have a direct, specific match
    // (near-exact question/error-key hit) -- rewording it through the LLM
    // adds ~1-3s of network latency and an API call for no real benefit.
    static HIGH_CONFIDENCE = 0.55;

    async answer(query, history, machineContext) {
        const suggestedAction = detectAction(query);

        // A jog attempt with an ambiguous axis/distance short-circuits doc
        // retrieval entirely -- the useful answer here is the clarifying
        // question itself, not whatever KB entry happens to score highest.
        if (suggestedAction && suggestedAction.clarification) {
            return {
                answer: suggestedAction.clarification,
                sources: [],
                usedOnline: false,
                suggestedAction: { action: suggestedAction.action, label: suggestedAction.label, autoExec: false },
            };
        }

        const best = this._retrieve(query); // single retrieval pass, reused below
        let result;
        if (best && best.score >= ChatbotService.HIGH_CONFIDENCE) {
            result = this._offlineAnswer(best);
        } else {
            const online = await this._onlineAnswer(query, history, machineContext, best);
            result = online || this._offlineAnswer(best);
        }
        return { ...result, suggestedAction };
    }
}

module.exports = { ChatbotService };
