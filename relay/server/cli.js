'use strict';

const path = require('path');
const fs = require('fs');
const readline = require('readline');

const { parseConfig } = require('./config');
const { openDatabase, backupDatabase } = require('./store/db');
const { migrate } = require('./store/migrations');
const { hashPassword, validatePassword, normalizeEmail } = require('./auth/passwords');
const { newId } = require('./auth/tokens');
const { createInvites } = require('./http/routes/admin');
const clock = require('./clock');

const USAGE = `usage: node server/cli.js <command> [options]
  create-user --email <e> --name <n> [--admin] [--password-stdin]
  reset-password --email <e> [--password-stdin]
  list-users
  disable-user --email <e> [--enable]
  create-invite [--count N] [--days D]
  backup --out <file>`;

function parseArgs(argv) {
    const out = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith('--')) {
            const key = a.slice(2);
            const next = argv[i + 1];
            if (next === undefined || next.startsWith('--')) out[key] = true;
            else {
                out[key] = next;
                i++;
            }
        } else {
            out._.push(a);
        }
    }
    return out;
}

function readAllStdin() {
    return new Promise((resolve, reject) => {
        const chunks = [];
        process.stdin.on('data', (c) => chunks.push(c));
        process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        process.stdin.on('error', reject);
    });
}

// Prompts without echoing the typed characters.
function promptHidden(question) {
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
        rl.stdoutMuted = true;
        rl._writeToOutput = function writeToOutput(s) {
            if (!rl.stdoutMuted || s.startsWith(question)) rl.output.write(s);
        };
        rl.question(question, (answer) => {
            rl.close();
            process.stdout.write('\n');
            resolve(answer);
        });
    });
}

async function readPassword(args, label) {
    if (args['password-stdin']) {
        const raw = await readAllStdin();
        return raw.replace(/\r?\n$/, '');
    }
    const first = await promptHidden(`${label}: `);
    const second = await promptHidden(`Repeat ${label.toLowerCase()}: `);
    if (first !== second) throw new Error('passwords do not match');
    return first;
}

function openDb(dataDir) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const db = openDatabase(path.join(dataDir, 'relay.db'), { busyTimeoutMs: 5000 });
    migrate(db);
    return db;
}

async function run(argv, env = process.env, io = { out: (s) => process.stdout.write(s + '\n') }) {
    const args = parseArgs(argv);
    const cmd = args._[0];
    if (!cmd) {
        io.out(USAGE);
        return 1;
    }
    const { config } = parseConfig(env);
    const db = openDb(config.dataDir);
    try {
        switch (cmd) {
            case 'create-user': {
                const email = normalizeEmail(args.email);
                const name = typeof args.name === 'string' ? args.name.trim() : '';
                if (!email) throw new Error('--email is required and must be valid');
                if (!name || name.length > 60) throw new Error('--name is required (1-60 characters)');
                if (db.get('SELECT 1 AS x FROM users WHERE email = ?', email)) throw new Error('a user with that email already exists');
                const password = await readPassword(args, 'Password');
                if (!validatePassword(password)) throw new Error('password must be 10-200 characters');
                const id = newId('u_');
                const hash = await hashPassword(password);
                // Decision D5: the first account on a relay becomes its admin even without
                // --admin, otherwise an invite-only relay would have nobody able to invite.
                const first = db.transaction(() => {
                    if (db.get('SELECT 1 AS x FROM users WHERE email = ?', email)) throw new Error('a user with that email already exists');
                    const isFirst = !db.get('SELECT 1 AS x FROM users LIMIT 1');
                    const admin = !!args.admin || isFirst;
                    db.run('INSERT INTO users(id, email, display_name, password_hash, is_admin, created_at) VALUES (?,?,?,?,?,?)',
                        id, email, name, hash, admin ? 1 : 0, clock.now());
                    db.run('INSERT INTO audit(ts, user_id, action, detail) VALUES (?,?,?,?)', clock.now(), id, 'auth.register', JSON.stringify({ mode: 'cli', admin, firstUser: isFirst }));
                    return { admin, isFirst };
                });
                io.out(`created user ${id}${first.admin ? ' (admin)' : ''}`);
                if (first.isFirst && !args.admin) io.out('first account on this relay: granted admin');
                return 0;
            }
            case 'reset-password': {
                const email = normalizeEmail(args.email);
                const user = email ? db.get('SELECT id FROM users WHERE email = ?', email) : null;
                if (!user) throw new Error('user not found');
                const password = await readPassword(args, 'New password');
                if (!validatePassword(password)) throw new Error('password must be 10-200 characters');
                const hash = await hashPassword(password);
                db.transaction(() => {
                    db.run('UPDATE users SET password_hash = ? WHERE id = ?', hash, user.id);
                    db.run('DELETE FROM sessions WHERE user_id = ?', user.id);
                    // The running server polls this table and closes live sockets (§4.2).
                    db.run('INSERT INTO session_revocations(user_id, created_at) VALUES (?, ?)', user.id, clock.now());
                    db.run('INSERT INTO audit(ts, user_id, action, detail) VALUES (?,?,?,?)', clock.now(), user.id, 'auth.password_change', JSON.stringify({ by: 'cli' }));
                });
                io.out('password reset; all sessions revoked');
                return 0;
            }
            case 'list-users': {
                for (const u of db.all('SELECT id, email, display_name, is_admin, disabled, created_at FROM users ORDER BY created_at')) {
                    io.out(`${u.id}\t${u.email}\t${u.display_name}\t${u.is_admin ? 'admin' : '-'}\t${u.disabled ? 'disabled' : 'active'}\t${new Date(u.created_at).toISOString()}`);
                }
                return 0;
            }
            case 'disable-user': {
                const email = normalizeEmail(args.email);
                const user = email ? db.get('SELECT id FROM users WHERE email = ?', email) : null;
                if (!user) throw new Error('user not found');
                const enable = !!args.enable;
                db.transaction(() => {
                    db.run('UPDATE users SET disabled = ? WHERE id = ?', enable ? 0 : 1, user.id);
                    if (!enable) {
                        db.run('DELETE FROM sessions WHERE user_id = ?', user.id);
                        db.run('INSERT INTO session_revocations(user_id, created_at) VALUES (?, ?)', user.id, clock.now());
                    }
                    db.run('INSERT INTO audit(ts, user_id, action, detail) VALUES (?,?,?,?)', clock.now(), null, 'admin.user_disable', JSON.stringify({ targetUserId: user.id, disabled: !enable, by: 'cli' }));
                });
                io.out(enable ? 'user enabled' : 'user disabled; sessions revoked');
                return 0;
            }
            case 'create-invite': {
                const count = args.count === undefined ? 1 : Number(args.count);
                const days = args.days === undefined ? 7 : Number(args.days);
                if (!Number.isInteger(count) || count < 1 || count > 20) throw new Error('--count must be 1-20');
                if (!Number.isInteger(days) || days < 1 || days > 30) throw new Error('--days must be 1-30');
                for (const code of createInvites(db, clock, { count, expiresInDays: days })) io.out(code);
                return 0;
            }
            case 'backup': {
                if (typeof args.out !== 'string') throw new Error('--out <file> is required');
                const out = path.resolve(args.out);
                fs.mkdirSync(path.dirname(out), { recursive: true });
                await backupDatabase(db, out, { rate: 100 });
                io.out(`backup written to ${out}`);
                return 0;
            }
            default:
                io.out(USAGE);
                return 1;
        }
    } finally {
        db.close();
    }
}

if (require.main === module) {
    run(process.argv.slice(2)).then((code) => process.exit(code), (err) => {
        process.stderr.write(`error: ${err.message}\n`);
        process.exit(1);
    });
}

module.exports = { run, parseArgs };
