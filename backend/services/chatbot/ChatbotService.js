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
    return String(text)
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 1 && !STOPWORDS.has(w));
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

// v1 allowlist: parameter-free actions can be auto-executed by the frontend.
// jog/probe/job_start need parameters we can't safely infer from chat text,
// so they stay guide-only until Tawfiq signs off on extending the allowlist.
const ACTION_PATTERNS = [
    { action: 'home', label: 'Home all axes', autoExec: true, re: /\bhome\b|\bhoming\b/ },
    { action: 'unlock', label: 'Clear the alarm', autoExec: true, re: /\bclear\b.*\balarm\b|\bunlock\b|\breset\b.*\balarm\b/ },
    { action: 'job_pause', label: 'Pause the job', autoExec: true, re: /\bpause\b/ },
    { action: 'job_resume', label: 'Resume the job', autoExec: true, re: /\bresume\b|\bcontinue\b.*\bjob\b/ },
    { action: 'job_stop', label: 'Stop the job', autoExec: true, re: /\bstop\b.*\bjob\b|\babort\b/ },
    { action: 'jog', label: 'Jog an axis', autoExec: false, re: /\bjog\b|\bmove\b.*\b(x|y|z)\b.*\baxis\b/ },
    { action: 'probe', label: 'Run a probe cycle', autoExec: false, re: /\bprobe\b|\btouch.?plate\b/ },
    { action: 'job_start', label: 'Start the loaded job', autoExec: false, re: /\bstart\b.*\bjob\b|\brun\b.*\b(gcode|g-code|file)\b/ },
];

function detectAction(query) {
    const q = query.toLowerCase();
    for (const p of ACTION_PATTERNS) {
        if (p.re.test(q)) return { action: p.action, label: p.label, autoExec: p.autoExec };
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
                if (obj.question && obj.answer) this.qaPairs.push(obj);
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
                this.errorEntries.push({
                    key: key[1].trim(),
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
            if (trimmed.length > 40) this.docChunks.push({ text: trimmed.slice(0, 1200), source: sourceName });
        }
    }

    // Returns { answer, sources, score } — the best offline match, or a
    // generic "don't know" if nothing scores above threshold.
    _retrieve(query) {
        const qTokens = tokenize(query);
        let best = null;

        for (const kb of this.errorEntries) {
            const score = overlapScore(qTokens, tokenize(kb.key));
            if (!best || score > best.score) {
                best = {
                    score,
                    answer: `${kb.means ? kb.means + ' ' : ''}${kb.fix}${kb.nav ? ` (Where: ${kb.nav})` : ''}`,
                    sources: ['serial_error_kb.txt'],
                };
            }
        }

        for (const qa of this.qaPairs) {
            const score = overlapScore(qTokens, tokenize(qa.question));
            if (!best || score > best.score) {
                best = { score, answer: qa.answer, sources: ['control_software_qa.jsonl'] };
            }
        }

        for (const chunk of this.docChunks) {
            const score = overlapScore(qTokens, tokenize(chunk.text)) * 0.7; // prose chunks are noisier, downweight
            if (!best || score > best.score) {
                best = { score, answer: chunk.text, sources: [chunk.source] };
            }
        }

        return best;
    }

    _offlineAnswer(query) {
        const best = this._retrieve(query);
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

    async _onlineAnswer(query, history, machineContext) {
        const apiKey = process.env.GROQ_API_KEY;
        if (!apiKey) return null;

        const best = this._retrieve(query);
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

    async answer(query, history, machineContext) {
        const suggestedAction = detectAction(query);
        const online = await this._onlineAnswer(query, history, machineContext);
        const result = online || this._offlineAnswer(query);
        return { ...result, suggestedAction };
    }
}

module.exports = { ChatbotService };
