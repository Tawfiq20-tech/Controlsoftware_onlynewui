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

// Input limits. /api/chat is reachable through the remote-access tunnel, so
// anything a client sends is untrusted: cap sizes and never let it inject a
// system-role message into the Groq prompt.
const MAX_MESSAGE_CHARS = 500;
const MAX_HISTORY_ENTRIES = 6;
const MAX_HISTORY_ENTRY_CHARS = 1000;
const MAX_CONTEXT_FIELD_CHARS = 200;

// Global Groq budget. Tunnel traffic arrives from loopback, so a per-IP limit
// would lump remote users in with the local operator -- instead, past this
// budget answers simply fall back to offline retrieval (never refused).
const GROQ_MAX_CALLS_PER_MINUTE = 20;

const STOPWORDS = new Set([
    'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'to', 'of',
    'in', 'on', 'for', 'and', 'or', 'it', 'my', 'i', 'do', 'does', 'did',
    'how', 'what', 'why', 'when', 'can', 'you', 'me', 'this', 'that', 'with',
    'where', 'which', 'should', 'would', 'could', 'will', 'there', 'please',
    'at', 'by', 'from', 'as', 'if', 'so', 'into', 'your', 'we', 'our', 'us',
    'im', 'its', 'has', 'have', 'had', 'get', 'got', 'just', 'also', 'about',
    'want', 'need', 'some', 'any', 'way', 'then', 'them', 'they', 'am',
]);

// Multi-word and punctuated spellings collapsed to one word before the text
// is split, so "g-code", "G code" and "gcode" all become the same token.
const PHRASES = [
    [/\bg[\s-]?code\b/g, 'gcode'],
    [/\be[\s-]stop\b|\bemergency[\s-]stop\b/g, 'estop'],
    [/\btouch[\s-]?(plate|off)\b/g, 'probe'],
    [/\bend[\s-]mill\b/g, 'bit'],
    [/\bwi[\s-]fi\b/g, 'wifi'],
    [/\bfeed[\s-]?rate\b/g, 'feed'],
    [/\bset[\s-]up\b/g, 'setup'],
    [/\b([23])[\s-]d\b/g, '$1d'],
    [/\bwon['’]t\b/g, 'will not'],
    [/\bcan['’]t\b/g, 'can not'],
    [/n['’]t\b/g, ' not'],
];

// Operators rarely use the words the docs use ("upload a design" means "load
// a G-code file"). Each key is folded into its value on both the query and
// the docs side, so either wording matches the other. Keys are matched after
// stemming, so listing the base form covers "uploading", "uploaded", etc.
const SYNONYMS = {
    upload: 'load', import: 'load',
    design: 'file', drawing: 'file', artwork: 'file',
    nc: 'gcode', ngc: 'gcode', tap: 'gcode',
    router: 'spindle',
    origin: 'zero', datum: 'zero',
    emergency: 'estop',
    millimeter: 'mm', millimetre: 'mm', metric: 'mm', inches: 'inch', imperial: 'inch',
    move: 'jog', nudge: 'jog',
    begin: 'start', launch: 'start', run: 'start',
    halt: 'stop', abort: 'stop', cancel: 'stop', cancelled: 'stop', kill: 'stop',
    endmill: 'bit', cutter: 'bit', tool: 'bit',
    touchplate: 'probe',
    webcam: 'camera', cam: 'camera',
    notify: 'notification', alert: 'notification',
    delete: 'remove', erase: 'remove',
    switch: 'change', toggle: 'change', swap: 'change',
    show: 'see', display: 'see', find: 'see', locate: 'see',
    add: 'create', new: 'create',
    preferences: 'settings', config: 'settings', configuration: 'settings',
    configure: 'settings', options: 'settings',
    axes: 'axis',
    fail: 'neg', broken: 'neg',
    mobile: 'phone', tablet: 'phone', ipad: 'phone', iphone: 'phone', android: 'phone',
    wireless: 'wifi', lan: 'wifi', network: 'wifi',
    past: 'history', previous: 'history',
    hotkey: 'shortcut', keybind: 'shortcut', keybinding: 'shortcut',
    fast: 'speed', faster: 'speed', slow: 'speed', slower: 'speed', quick: 'speed',
};

// Words looked up before stemming: the stemmer would fold "setting" into
// "set" and "note" into "not", which are different things.
const EXACT_WORDS = new Map([
    ['setting', 'settings'], ['settings', 'settings'],
    ...['not', 'no', 'cannot', 'never', 'dont', 'doesnt', 'wont', 'cant', 'isnt', 'didnt'].map((w) => [w, 'neg']),
]);

// Crude suffix stripper -- just enough that "homing"/"home"/"homed" and
// "probes"/"probing" land on the same token. It only has to be consistent,
// since the same function runs on both sides.
function stem(word) {
    if (EXACT_WORDS.has(word)) return EXACT_WORDS.get(word);
    if (word.length <= 3 || /\d/.test(word)) return word;
    let s = word;
    if (s.endsWith('ies') && s.length > 4) s = `${s.slice(0, -3)}y`;
    else if (s.endsWith('es') && s.length >= 5 && !s.endsWith('sses')) s = s.slice(0, -2);
    else if (s.endsWith('s') && s.length >= 4 && !/(ss|us|is)$/.test(s)) s = s.slice(0, -1);

    if (s.endsWith('ing') && s.length >= 6) s = s.slice(0, -3);
    else if (s.endsWith('ed') && s.length >= 5 && !s.endsWith('eed')) s = s.slice(0, -2);
    else if (s.endsWith('tion') && s.length >= 7) s = s.slice(0, -3);

    if (s.endsWith('e') && s.length >= 4) s = s.slice(0, -1);
    // jogging -> jogg -> jog, stopped -> stopp -> stop
    if (s !== word && s.length >= 4 && /([bdgmnprt])\1$/.test(s)) s = s.slice(0, -1);
    return s;
}

const SYNONYMS_BY_STEM = new Map(Object.entries(SYNONYMS).map(([k, v]) => [stem(k), stem(v)]));

function canonical(word) {
    const s = stem(word);
    return SYNONYMS_BY_STEM.get(s) || s;
}

function splitWords(text) {
    let normalized = String(text).toLowerCase();
    for (const [re, replacement] of PHRASES) normalized = normalized.replace(re, replacement);
    return normalized
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        // Keep single digits: "ALARM:2" must not collapse to just "alarm"
        // and match ALARM:1's entry.
        .filter((w) => w.length > 1 || /\d/.test(w));
}

function tokenize(text) {
    const words = splitWords(text);
    const stripped = words.filter((w) => !STOPWORDS.has(w));
    // Short phrases built entirely from stopwords (e.g. "what can you do")
    // would otherwise tokenize to nothing and score 0 against every entry,
    // including their own exact-match QA pair. Fall back to the unfiltered
    // words so an exact phrase can still match itself.
    const kept = stripped.length > 0 ? stripped : words;
    return [...new Set(kept.map(canonical))];
}

// Every word, stopwords included. Only used to break ties between entries
// whose content words match equally: "can you home the machine" then prefers
// "Can you home the machine?" over "How do I home my machine?".
function tokenizeAll(text) {
    return [...new Set(splitWords(text).map(canonical))];
}

// Dice coefficient (2*overlap / sum of lengths) rather than plain recall —
// this prefers a short, direct question match over a longer tangential one
// that happens to contain the same keywords. (Weighting tokens by rarity was
// tried and scored worse on paraphrased operator questions: a rare word in a
// tangential entry outranked the right one.)
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

// An axis letter standing on its own or glued to a number ("x", "x10", "z-2").
const AXIS_LETTER_RE = /(?:^|[^a-z])([xyz])(?![a-z])/;

const JOG_INTENT_RE = new RegExp(
    `\\bjog\\b|\\bnudge\\b|\\b(move|shift)\\b.*(?:(?:^|[^a-z])[xyz](?![a-z])|\\b(?:${Object.keys(DIRECTION_WORDS).join('|')})\\b)`
);

const FEED_PHRASE_RE = /(?:@|\bat\b|\bfeed(?:\s*rate)?\b|\bspeed\b)\s*(\d+(?:\.\d+)?)/;

// "move X to 0" is an absolute move; chat only does relative jogs.
const ABSOLUTE_MOVE_RE = /\bto\s*[xyz]?\s*[-+]?\s*\d/;

// Unit written right after the distance number. Anything else is mm.
const DISTANCE_UNITS = [
    { re: /^\s*(?:mm\b|millimet(?:er|re)s?\b)/, factor: 1, name: 'mm' },
    { re: /^\s*(?:cm\b|centimet(?:er|re)s?\b)/, factor: 10, name: 'cm' },
    { re: /^\s*(?:"|in\b|inch(?:es)?\b)/, factor: 25.4, name: 'in' },
];

function formatNum(n) {
    return Number(n.toFixed(2)).toString();
}

// Returns { ok: true, axis, distance, feedRate, notes } on a clean parse, or
// { ok: false, reason } when the axis or distance is ambiguous -- callers
// must surface `reason` as a clarifying question rather than guessing.
// `notes` lists every adjustment made (unit conversion, clamping) so the
// operator is told, not just shown a different number.
function parseJogCommand(text) {
    const lower = text.toLowerCase();

    if (ABSOLUTE_MOVE_RE.test(lower.replace(FEED_PHRASE_RE, ' '))) {
        return {
            ok: false,
            reason: 'From chat I can only jog by a distance, not move to a position. Tell me how far, e.g. "jog X -10mm".',
        };
    }

    const notes = [];
    let feedRate = JOG_DEFAULT_FEED;
    const feedMatch = FEED_PHRASE_RE.exec(lower);
    if (feedMatch) {
        const requested = parseFloat(feedMatch[1]);
        feedRate = Math.min(Math.max(requested, JOG_MIN_FEED), JOG_MAX_FEED);
        if (feedRate !== requested) notes.push(`speed limited to ${Math.round(feedRate)}mm/min`);
    }
    const q = feedMatch ? lower.replace(FEED_PHRASE_RE, ' ') : lower;

    let dirWord = null;
    for (const word of Object.keys(DIRECTION_WORDS)) {
        if (new RegExp(`\\b${word}\\b`).test(q)) { dirWord = word; break; }
    }
    const dir = dirWord ? DIRECTION_WORDS[dirWord] : null;
    const letterMatch = AXIS_LETTER_RE.exec(q);
    const letterAxis = letterMatch ? letterMatch[1] : null;

    if (dir && letterAxis && dir.axis !== letterAxis) {
        return {
            ok: false,
            reason: `"${dirWord}" moves ${dir.axis.toUpperCase()}, but you also said ${letterAxis.toUpperCase()}. Which axis did you mean?`,
        };
    }
    const axis = letterAxis || (dir && dir.axis);
    if (!axis) {
        return { ok: false, reason: 'Which axis? Tell me X, Y, or Z (e.g. "jog X 10mm").' };
    }

    // Prefer the number glued to the axis letter ("x10", "z -2"), otherwise
    // the first number in the message.
    const numRe = letterAxis
        ? new RegExp(`(?:^|[^a-z])${letterAxis}\\s*([-+])?\\s*(\\d+(?:\\.\\d+)?)`)
        : /([-+])?\s*(\d+(?:\.\d+)?)/;
    const numMatch = numRe.exec(q) || /([-+])?\s*(\d+(?:\.\d+)?)/.exec(q);
    const rawDistance = numMatch ? parseFloat(numMatch[2]) : 0;
    if (!rawDistance) {
        return {
            ok: false,
            reason: `How far should I jog ${axis.toUpperCase()}? Give me a distance in mm (e.g. "jog ${axis.toUpperCase()} 10mm").`,
        };
    }

    // Explicit sign overrides a direction word's implied sign.
    let sign = dir ? dir.sign : 1;
    if (numMatch[1] === '-' || /\bminus\b|\bnegative\b/.test(q)) sign = -1;
    else if (numMatch[1] === '+' || /\bplus\b|\bpositive\b/.test(q)) sign = 1;

    const after = q.slice(numMatch.index + numMatch[0].length);
    const unit = DISTANCE_UNITS.find((u) => u.re.test(after)) || DISTANCE_UNITS[0];
    let distanceMm = rawDistance * unit.factor;
    if (unit.factor !== 1) notes.push(`${formatNum(rawDistance)}${unit.name} converted to ${formatNum(distanceMm)}mm`);

    const clamped = Math.min(Math.max(distanceMm, JOG_MIN_DISTANCE_MM), JOG_MAX_DISTANCE_MM);
    if (clamped !== distanceMm) {
        notes.push(`limited from ${formatNum(distanceMm)}mm to ${formatNum(clamped)}mm (chat jog range is ${JOG_MIN_DISTANCE_MM}–${JOG_MAX_DISTANCE_MM}mm)`);
    }
    distanceMm = clamped * sign;

    return {
        ok: true,
        axis,
        distance: Math.round(distanceMm * 100) / 100,
        feedRate: Math.round(feedRate),
        notes,
    };
}

// Messages that ask about something rather than ask for it. "why does my job
// pause randomly" must not offer a Pause button. Polite requests and how-to
// questions ("can you home", "how do I home") still count as requests -- the
// frontend confirm tap is the real safety gate.
const REQUEST_PREFIX_RE = /^\s*(?:(?:hey|ok|okay)\s+)?(?:please\s+|pls\s+)?(?:(?:can|could|would|will)\s+you\b|how\s+(?:do|can|should)\s+(?:i|we|you)\b|how\s+to\b)/;
const QUESTION_PREFIX_RE = /^\s*(?:why|what|when|where|which|who|whose|is|are|was|were|does|did|has|have|should|shall)\b/;
const PROBLEM_RE = /\b(?:fail(?:s|ed|ing|ure)?|not\s+working|won'?t|doesn'?t|didn'?t|can'?t|cannot|keeps|randomly|stuck|broken|problem|issue|wrong)\b/;

function isInformational(lower) {
    if (PROBLEM_RE.test(lower)) return true;
    if (REQUEST_PREFIX_RE.test(lower)) return false;
    return QUESTION_PREFIX_RE.test(lower) || /\?\s*$/.test(lower);
}

// "home" in the app also names the Home menu/screen and the work-zero concept.
const HOME_NOT_HOMING_RE = /\bhome\s+(?:menu|screen|tab|page|position|button|icon)\b|\bzero\b|\bset\s+(?:\w+\s+)?home\b|\bback\s+(?:to\s+)?(?:the\s+)?home\b/;

// v1 allowlist: home/unlock/feed_hold/job_pause/job_resume/job_stop are
// parameter-free (nothing to get wrong), jog is parameterized but clamped +
// confirm-gated (see above), probe/job_start remain guide-only.
const ACTION_PATTERNS = [
    { action: 'home', label: 'Home all axes', autoExec: true, re: /\bhome\b|\bhoming\b/, exclude: HOME_NOT_HOMING_RE },
    { action: 'unlock', label: 'Clear the alarm', autoExec: true, re: /\bclear\b.*\balarm\b|\bunlock\b|\breset\b.*\balarm\b/ },
    { action: 'feed_hold', label: 'Feed hold (pause motion)', autoExec: true, re: /\bfeed\s*hold\b|^\s*hold\s*[.!]*\s*$/ },
    { action: 'job_pause', label: 'Pause the job', autoExec: true, re: /\bpause\b/ },
    { action: 'job_resume', label: 'Resume the job', autoExec: true, re: /\bresume\b|\bcontinue\b.*\bjob\b/ },
    {
        action: 'job_stop', label: 'Stop the job', autoExec: true,
        re: /^\s*(?:stop|abort)(?:\s+(?:it|now|everything|the\s+machine))?\s*[.!]*\s*$|\bstop\b.*\bjob\b|\babort\b/,
    },
    { action: 'jog', label: 'Jog an axis', autoExec: false, re: JOG_INTENT_RE },
    { action: 'probe', label: 'Run a probe cycle', autoExec: false, re: /\bprobe\b|\btouch.?plate\b/ },
    { action: 'job_start', label: 'Start the loaded job', autoExec: false, re: /\bstart\b.*\bjob\b|\brun\b.*\b(gcode|g-code|file)\b/ },
];

const QUESTION_RE = /\?|^\s*(how|what|why|where|when|which|who|can|could|does|do|is|are|should|will|would)\b/;

function detectAction(query) {
    const q = String(query).toLowerCase().replace(/[‘’]/g, "'");
    if (isInformational(q)) return null;
    const howTo = REQUEST_PREFIX_RE.test(q) && /\bhow\b/.test(q);

    for (const p of ACTION_PATTERNS) {
        if (!p.re.test(q) || (p.exclude && p.exclude.test(q))) continue;
        if (p.action === 'jog') {
            const parsed = parseJogCommand(q);
            if (!parsed.ok) {
                // "why won't my jog buttons work?" is a question about
                // jogging, not a jog command missing its distance -- asking
                // "Which axis?" back would hide the docs answer.
                if (QUESTION_RE.test(q)) continue;
                return { action: 'jog', label: p.label, autoExec: false, clarification: parsed.reason };
            }
            const sign = parsed.distance < 0 ? '-' : '+';
            const label = `Jog ${parsed.axis.toUpperCase()} ${sign}${formatNum(Math.abs(parsed.distance))}mm @ ${parsed.feedRate}mm/min`;
            const noteText = parsed.notes.length ? ` Note: ${parsed.notes.join('; ')}.` : '';
            return {
                action: 'jog',
                label,
                autoExec: true,
                params: { axis: parsed.axis, distance: parsed.distance, feedRate: parsed.feedRate },
                summary: `Ready to ${label.charAt(0).toLowerCase()}${label.slice(1)}.${noteText} Confirm below to send it.`,
            };
        }
        return { action: p.action, label: p.label, autoExec: p.autoExec };
    }
    return null;
}

// Keep only user/assistant turns with string content, size-capped. Anything
// else (system/tool roles, objects, oversized pastes) is dropped.
function sanitizeHistory(history) {
    if (!Array.isArray(history)) return [];
    return history
        .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
        .slice(-MAX_HISTORY_ENTRIES)
        .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_HISTORY_ENTRY_CHARS) }));
}

function contextField(value) {
    if (value === null || value === undefined) return null;
    return String(value).replace(/\s+/g, ' ').slice(0, MAX_CONTEXT_FIELD_CHARS);
}

function sanitizeMachineContext(ctx) {
    if (!ctx || typeof ctx !== 'object') return null;
    return {
        state: contextField(ctx.state),
        connected: typeof ctx.connected === 'boolean' ? ctx.connected : null,
        loadedFile: contextField(ctx.loadedFile),
        lastError: contextField(ctx.lastError),
    };
}

function formatErrorEntry(kb) {
    return `${kb.means ? kb.means + ' ' : ''}${kb.fix}${kb.nav ? ` (Where: ${kb.nav})` : ''}`;
}

class ChatbotService {
    constructor() {
        this.qaPairs = [];      // { question, answer }
        this.errorEntries = []; // { key, means, fix, nav }
        this.docChunks = [];    // { text, source }
        this._groqCallTimes = [];
        this.outboundAllowed = true;
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
                    // `aliases` are other wordings of the same question; the
                    // entry scores as its best-matching phrasing.
                    obj.phrasings = [obj.question, ...(Array.isArray(obj.aliases) ? obj.aliases : [])]
                        .map((text) => ({ tokens: tokenize(text), allTokens: tokenizeAll(text) }))
                        .filter((p) => p.tokens.length > 0);
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
                    keyAllTokens: tokenizeAll(keyStr),
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

    // Every entry scored against the query, best first: { score, tie, answer,
    // sources, question? } (question only on QA entries). `tie` is the
    // all-words overlap, used only when `score` is equal. Uses the tokens
    // cached at load time (_loadQaJsonl/_loadErrorKb/_loadMarkdown) instead of
    // re-tokenizing every entry on every query. The sort is stable, so on a
    // full tie an error entry beats a QA pair and a QA pair beats a prose chunk.
    // "alarm 2", "ALARM:9", "error:22" -- an exact code lookup beats any
    // keyword score, since every code entry shares the same words.
    _codeLookup(query) {
        const m = /\b(alarm|error)\s*[:#]?\s*(\d{1,3})\b/i.exec(query);
        if (!m) return null;
        const key = `${m[1].toLowerCase()}:${Number(m[2])}`;
        const kb = this.errorEntries.find((e) => e.key.toLowerCase() === key);
        if (!kb) return null;
        return {
            score: 1,
            tie: 1,
            answer: `**${kb.key}**: ${kb.means ? kb.means + ' ' : ''}${kb.fix}${kb.nav ? ` (Where: ${kb.nav})` : ''}`,
            sources: ['serial_error_kb.txt'],
        };
    }

    _rank(query) {
        const qTokens = tokenize(query);
        const qAllTokens = tokenizeAll(query);
        const ranked = [];

        for (const kb of this.errorEntries) {
            ranked.push({
                score: overlapScore(qTokens, kb.keyTokens),
                tie: overlapScore(qAllTokens, kb.keyAllTokens),
                answer: `${kb.means ? kb.means + ' ' : ''}${kb.fix}${kb.nav ? ` (Where: ${kb.nav})` : ''}`,
                sources: ['serial_error_kb.txt'],
            });
        }

        for (const qa of this.qaPairs) {
            let score = 0;
            let tie = 0;
            for (const p of qa.phrasings) {
                // One-word entries ("hi", "help", "see you") answer one- or
                // two-word messages only; otherwise "find the corner of my
                // workpiece" scores well against "see you" on "find" = "see".
                if (p.tokens.length === 1 && qTokens.length > 2) continue;
                const s = overlapScore(qTokens, p.tokens);
                const t = overlapScore(qAllTokens, p.allTokens);
                if (s > score || (s === score && t > tie)) { score = s; tie = t; }
            }
            ranked.push({ score, tie, answer: qa.answer, sources: ['control_software_qa.jsonl'], question: qa.question });
        }

        for (const chunk of this.docChunks) {
            ranked.push({
                score: overlapScore(qTokens, chunk.textTokens) * 0.7, // prose chunks are noisier, downweight
                tie: 0,
                answer: chunk.text,
                sources: [chunk.source],
            });
        }

        return ranked.sort((a, b) => b.score - a.score || b.tie - a.tie);
    }

    // Below MIN_ANSWER_SCORE the top match is more likely wrong than right, so
    // instead of answering it the reply offers the closest questions the
    // operator can tap to ask. Set from ~140 sample questions: every in-scope
    // paraphrase that was answered correctly scored 0.40 or more, while
    // off-topic ones ("wood burning marks on edges") mostly scored 0.33 or less.
    static MIN_ANSWER_SCORE = 0.35;
    static MIN_SUGGESTION_SCORE = 0.1;

    _offlineAnswer(ranked) {
        const best = ranked[0];
        if (!best || best.score < ChatbotService.MIN_ANSWER_SCORE) {
            const suggestions = [...new Set(
                ranked
                    .filter((c) => c.question && c.score >= ChatbotService.MIN_SUGGESTION_SCORE)
                    .map((c) => c.question)
            )].slice(0, 3);
            return {
                answer: suggestions.length > 0
                    ? "I'm not sure I understood that. Did you mean one of these?"
                    : "I don't have documentation matching that. Try asking about loading a file, jogging, homing, " +
                      'probing, running a job, alarms, connecting, cameras, remote access, settings, or a specific ' +
                      "error message you're seeing.",
                sources: [],
                usedOnline: false,
                suggestions,
            };
        }
        return { answer: best.answer, sources: best.sources, usedOnline: false, suggestions: [] };
    }

    /** LAN-only: false keeps every answer on the offline matcher. */
    setOutboundAllowed(allowed) {
        this.outboundAllowed = !!allowed;
    }

    async _onlineAnswer(query, history, machineContext, ranked) {
        if (!this.outboundAllowed) return null;
        const apiKey = process.env.GROQ_API_KEY;
        if (!apiKey) return null;
        if (!this._takeGroqBudget()) {
            logger.warn('[Chatbot] Groq budget exhausted for this minute, answering offline');
            return null;
        }

        const best = ranked[0];
        // Top few matches rather than only the best one: a paraphrased
        // question often ranks the right entry second or third.
        const context = ranked
            .slice(0, 3)
            .filter((c) => c.score >= 0.15)
            .map((c) => c.answer)
            .join('\n\n');
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
            ...history,
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
            return { answer, sources: best ? best.sources : [], usedOnline: true, suggestions: [] };
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

    async answer(rawQuery, rawHistory, rawMachineContext) {
        const query = String(rawQuery).slice(0, MAX_MESSAGE_CHARS);
        const history = sanitizeHistory(rawHistory);
        const machineContext = sanitizeMachineContext(rawMachineContext);
        const detected = detectAction(query);
        const suggestedAction = detected
            ? { action: detected.action, label: detected.label, autoExec: detected.autoExec, ...(detected.params ? { params: detected.params } : {}) }
            : null;

        // A jog attempt with an ambiguous axis/distance short-circuits doc
        // retrieval entirely -- the useful answer here is the clarifying
        // question itself, not whatever KB entry happens to score highest.
        // A fully-resolved jog likewise answers with the resolved command.
        if (detected && (detected.clarification || detected.summary)) {
            return {
                answer: detected.clarification || detected.summary,
                sources: [],
                usedOnline: false,
                suggestedAction,
            };
        }

        const code = this._codeLookup(query);
        const ranked = code ? [code] : this._rank(query); // single retrieval pass, reused below
        let result;
        if (ranked.length > 0 && ranked[0].score >= ChatbotService.HIGH_CONFIDENCE) {
            result = this._offlineAnswer(ranked);
        } else {
            const online = await this._onlineAnswer(query, history, machineContext, ranked);
            result = online || this._offlineAnswer(ranked);
        }
        return { ...result, suggestedAction };
    }
}

module.exports = {
    ChatbotService,
    detectAction,
    parseJogCommand,
    sanitizeHistory,
    MAX_MESSAGE_CHARS,
    GROQ_MAX_CALLS_PER_MINUTE,
};
