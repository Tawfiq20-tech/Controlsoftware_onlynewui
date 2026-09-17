'use strict';

/**
 * The chat assistant finds the right help entry for the way operators
 * actually ask.
 *
 * 2026-09-17: "how to upload a design" got "I don't have documentation
 * matching that" -- the docs say "load a G-code file", and retrieval only
 * matched the exact words. The QA file now carries aliases, and the tokenizer
 * folds stems and CNC synonyms together.
 */

process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';
delete process.env.GROQ_API_KEY; // offline answers only: no network in tests

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { ChatbotService } = require('../services/chatbot/ChatbotService');

const QA_FILE = path.join(__dirname, '../services/chatbot/docs/control_software_qa.jsonl');

function testQaFileIsWellFormed() {
    const lines = fs.readFileSync(QA_FILE, 'utf8').split('\n').filter(Boolean);
    const questions = new Set();
    lines.forEach((line, i) => {
        const e = JSON.parse(line);
        assert.ok(typeof e.question === 'string' && e.question.trim(), `line ${i + 1}: question`);
        assert.ok(typeof e.answer === 'string' && e.answer.trim(), `line ${i + 1}: answer`);
        if (e.aliases !== undefined) {
            assert.ok(Array.isArray(e.aliases) && e.aliases.every((a) => typeof a === 'string' && a.trim()), `line ${i + 1}: aliases`);
        }
        const key = e.question.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
        assert.ok(!questions.has(key), `line ${i + 1}: duplicate question "${e.question}"`);
        questions.add(key);
    });
    console.log(`  ok  ${lines.length} QA entries parse, no duplicate questions`);
}

function testEveryQuestionFindsItsOwnAnswer(svc) {
    // A new entry whose words match an existing one exactly would make one of
    // the two unreachable -- reword it or fold it into the other.
    const shadowed = svc.qaPairs.filter((qa) => svc._rank(qa.question)[0].answer !== qa.answer);
    assert.deepStrictEqual(shadowed.map((qa) => qa.question), [], 'questions answered by a different entry');
    console.log('  ok  every question retrieves its own answer');
}

async function testOperatorWordings(svc) {
    const cases = [
        ['how to upload a design', /File Management|Browse/],
        ['import my nc file', /File Management|Browse/],
        ['set my work origin', /ZERO ALL|zero/],
        ['machine is locked', /Clear Alarm|alarm/i],
        ['start cutting', /Start/],
        ['slow down the cut', /Feed Override|override/i],
        ['control the machine from my phone', /Remote access/],
        ['flatten my spoilboard', /Surfacing/],
        ['add a webcam', /Cameras|camera/i],
        ['text me when my job finishes', /WhatsApp/],
        ['what file types can I open', /\.gcode/],
        ['find the corner of my workpiece', /XYZ|corner/i],
        ['update firmware', /[Ff]irmware/],
        ['trace the outline of the job', /[Oo]utline/],
    ];
    for (const [query, expected] of cases) {
        const r = await svc.answer(query, [], null);
        assert.match(r.answer, expected, `"${query}" -> ${r.answer.slice(0, 120)}`);
    }
    console.log(`  ok  ${cases.length} everyday wordings reach the right answer`);
}

async function testSmallTalkDoesNotSwallowQuestions(svc) {
    // "find" folds into "see", and "see you" is a one-word entry -- it must not
    // answer a longer question that merely shares that word.
    const r = await svc.answer('find the corner of my workpiece', [], null);
    assert.doesNotMatch(r.answer, /^See you/);
    const hi = await svc.answer('hi', [], null);
    assert.match(hi.answer, /^Hi!/);
    console.log('  ok  one-word small talk only answers short messages');
}

async function testUnclearQuestionOffersSuggestions(svc) {
    // Shares a word or two with real entries, but nothing answers it.
    const r = await svc.answer('wood burning marks on edges', [], null);
    assert.match(r.answer, /Did you mean/);
    assert.ok(r.suggestions.length > 0 && r.suggestions.length <= 3, 'up to 3 tap-to-ask suggestions');
    const nothing = await svc.answer('zzzz qqqq', [], null);
    assert.deepStrictEqual(nothing.suggestions, []);
    assert.match(nothing.answer, /don't have documentation/);
    console.log('  ok  low-confidence answers carry suggestions (empty when nothing is close)');
}

async function testJogQuestionsAreNotJogCommands(svc) {
    const question = await svc.answer("why won't my jog buttons work?", [], null);
    assert.doesNotMatch(question.answer, /Which axis/, 'a question about jogging gets the docs answer');

    const incomplete = await svc.answer('jog x', [], null);
    assert.match(incomplete.answer, /How far should I jog X/, 'a command missing its distance still asks');

    const command = await svc.answer('jog x 10mm', [], null);
    assert.deepStrictEqual(command.suggestedAction.params, { axis: 'x', distance: 10, feedRate: 1000 });
    console.log('  ok  jog questions get answers, jog commands still parse');
}

async function testPastedErrorStillMatchesTheErrorKb(svc) {
    const r = await svc.answer('ALARM: Machine locked (code 3). Press Reset to clear.', [], null);
    assert.deepStrictEqual(r.sources, ['serial_error_kb.txt']);
    console.log('  ok  a pasted controller error hits the error knowledge base');
}

(async () => {
    console.log('Testing chat assistant retrieval...');
    const svc = new ChatbotService();
    testQaFileIsWellFormed();
    testEveryQuestionFindsItsOwnAnswer(svc);
    await testOperatorWordings(svc);
    await testSmallTalkDoesNotSwallowQuestions(svc);
    await testUnclearQuestionOffersSuggestions(svc);
    await testJogQuestionsAreNotJogCommands(svc);
    await testPastedErrorStillMatchesTheErrorKb(svc);
    console.log('ALL TESTS PASSED SUCCESSFULLY!');
    process.exit(0);
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
