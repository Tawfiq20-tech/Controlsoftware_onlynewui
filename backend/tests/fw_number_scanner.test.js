'use strict';

/**
 * Firmware 0.2.0's G-code number scanner (FW-1), checked against every line of
 * the reference files.
 *
 * The C function lives in
 *   shortcut/firmware/source_0.2.0/Src/easycnc_protocol.c : gcode_strtof()
 * and is transliterated below statement for statement. There is no host C
 * compiler on this machine, so this is the closest executable check available:
 * it proves the ALGORITHM on real input. Anything structural in the C (types,
 * pointer handling) still rests on review -- keep the two in step by hand.
 *
 * What it must prove:
 *   1. On the reference corpus it reads exactly what a correct decimal parse
 *      reads, word for word, line for line.
 *   2. The hex-float trap is gone: "G0X11.1000" (no space, as several CAM
 *      posts write it) used to parse as G = 0x11.1 = 17.0625 with NO X word,
 *      and the machine ran the line with X wherever it happened to be -- the
 *      271 mm cut on 2026-09-13.
 *   3. It never invents a number where there is none, and never runs past the
 *      end of a word.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { strtof, gcodeStrtof } = require('./helpers/fakeFirmware'); // strtof models the OLD C library behaviour

const CORPUS = process.env.EASYCNC_CORPUS || 'C:/Users/Tawfiq/Downloads/gcode_test_file/file_finity';
const f32 = Math.fround;

/** The firmware's word loop (parse_gcode_text), with whichever scanner. */
function scanWords(line, scan) {
    const out = [];
    let i = 0;
    while (i < line.length) {
        const c = line[i++];
        if (c === ' ' || c === '\t') continue;
        const n = scan(line.slice(i));
        if (!n) continue;
        out.push({ letter: c.toUpperCase(), value: n.value });
        i += n.len;
    }
    return out;
}

const newScan = (s) => gcodeStrtof(s);
const oldScan = (s) => strtof(s);

/**
 * Two readings of the same word agree when they are the same number to within
 * a float32 ulp. Building a float from its digits and letting the C library do
 * it can differ in the last bit: at a coordinate of 1.5 that is 1.2e-7 mm, or
 * one forty-thousandth of a motor step. (Whether the STEPS come out identical
 * is checked where it actually matters -- tests/corpus_stream.test.js streams
 * every reference file through this scanner and compares the executed path
 * move by move.)
 */
function wordsAgree(got, want) {
    if (got.length !== want.length) return false;
    for (let i = 0; i < got.length; i++) {
        if (got[i].letter !== want[i].letter) return false;
        const a = got[i].value;
        const b = want[i].value;
        if (a === b) continue;
        const ulp = Math.max(Math.abs(b), 1e-6) * 1.2e-7;
        if (Math.abs(a - b) > 2 * ulp) return false;
    }
    return true;
}

/** What the words SHOULD be: plain decimal reading, letter by letter. */
function referenceWords(line) {
    const out = [];
    const re = /([A-Za-z])\s*([-+]?(?:\d+\.?\d*|\.\d+))/g;
    let m;
    while ((m = re.exec(line)) !== null) out.push({ letter: m[1].toUpperCase(), value: f32(parseFloat(m[2])) });
    return out;
}

function unitCases() {
    // the 2026-09-13 trap, exactly as the post writes it
    const trapNew = scanWords('G0X11.1000', newScan);
    const trapOld = scanWords('G0X11.1000', oldScan);
    assert.ok(wordsAgree(trapNew, [{ letter: 'G', value: 0 }, { letter: 'X', value: f32(11.1) }]),
        `0.2.0 reads G0 and X11.1, got ${JSON.stringify(trapNew)}`);
    assert.ok(trapOld.some((w) => w.letter === 'G' && Math.abs(w.value - 17.0625) < 1e-6),
        'the old scanner really did read G as the hex float 17.0625');
    assert.ok(!trapOld.some((w) => w.letter === 'X'), 'and really did lose the X word');

    // more shapes the old one mangled
    assert.ok(wordsAgree(scanWords('G1X0Y0Z0F600', newScan), [
        { letter: 'G', value: 1 }, { letter: 'X', value: 0 }, { letter: 'Y', value: 0 },
        { letter: 'Z', value: 0 }, { letter: 'F', value: 600 },
    ]));
    assert.ok(wordsAgree(scanWords('X-1.5Y.25Z+3.', newScan), [
        { letter: 'X', value: f32(-1.5) }, { letter: 'Y', value: f32(0.25) }, { letter: 'Z', value: 3 },
    ]));
    // no number, no word -- and no run-on
    assert.strictEqual(gcodeStrtof('X'), null);
    assert.strictEqual(gcodeStrtof('.'), null);
    assert.strictEqual(gcodeStrtof('+'), null);
    assert.strictEqual(gcodeStrtof(''), null);
    // hex / inf / nan are not numbers to this scanner
    assert.deepStrictEqual(gcodeStrtof('0x10'), { value: 0, len: 1 }, '"0x10" reads as 0, stopping at the x');
    assert.strictEqual(gcodeStrtof('inf'), null);
    assert.strictEqual(gcodeStrtof('nan'), null);
    // exponent form is not G-code: read the mantissa only, never a bigger number
    const exp = gcodeStrtof('3.0E2');
    assert.strictEqual(exp.value, 3, 'exponent notation reads as the mantissa (slower, never faster)');
    // long numbers do not overflow into nonsense
    const long = gcodeStrtof('1234567890.123456789');
    assert.ok(Math.abs(long.value - 1234567890.12) / 1234567890 < 1e-3);
    console.log('  ok  unit cases, including the 2026-09-13 hex-float trap');
}

function corpusCheck() {
    if (!fs.existsSync(CORPUS)) {
        console.log(`  SKIP corpus: ${CORPUS} not found`);
        return;
    }
    const files = fs.readdirSync(CORPUS).filter((f) => /\.(nc|ngc|gcode|tap|cnc)$/i.test(f)).sort();
    let lines = 0;
    let words = 0;
    let oldWrong = 0;
    const oldExamples = [];
    for (const f of files) {
        const text = fs.readFileSync(path.join(CORPUS, f), 'utf8');
        for (const raw of text.split(/\r?\n/)) {
            // comments are stripped before the firmware ever sees a line
            const code = raw.replace(/\([^)]*\)/g, ' ').replace(/;.*$/, '').trim();
            if (!code || code.startsWith('%')) continue;
            lines++;
            const want = referenceWords(code);
            const got = scanWords(code, newScan);
            words += want.length;
            assert.ok(wordsAgree(got, want), `${f}: 0.2.0 scanner disagrees on "${code}"\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`);
            const old = scanWords(code, oldScan);
            if (!wordsAgree(old, want)) {
                oldWrong++;
                if (oldExamples.length < 3) oldExamples.push(`${f}: "${code}" -> ${JSON.stringify(old)}`);
            }
        }
    }
    console.log(`  ok  ${words} words on ${lines} lines of the reference files read exactly right`);
    console.log(`      (the firmware on the board today misreads ${oldWrong} of those lines)`);
    for (const e of oldExamples) console.log(`        e.g. ${e}`);
}

(function main() {
    console.log('Testing firmware 0.2.0 number scanner (FW-1)...');
    unitCases();
    corpusCheck();
    console.log('ALL TESTS PASSED SUCCESSFULLY!');
})();
