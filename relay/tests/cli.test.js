'use strict';

const assert = require('assert');
const path = require('path');
const { spawn } = require('child_process');
const { runTests, tmpDir, removeDir } = require('./helpers/harness');
const { openDatabase } = require('../server/store/db');
const { verifyPassword } = require('../server/auth/passwords');

const CLI = path.join(__dirname, '..', 'server', 'cli.js');

function cli(dataDir, args, stdin) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, ...args], {
            env: Object.assign({}, process.env, { RELAY_DATA_DIR: dataDir, RELAY_PUBLIC_URL: '' }), stdio: ['pipe', 'pipe', 'pipe'],
        });
        let out = '';
        let err = '';
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { err += d; });
        child.on('close', (code) => resolve({ code, out, err }));
        child.stdin.end(stdin || '');
    });
}

runTests('Relay CLI', [
    ['create-user (admin), list-users, create-invite, disable-user, backup', async () => {
        const dir = tmpDir();
        try {
            let r = await cli(dir, ['create-user', '--email', 'Admin@Example.com', '--name', 'Admin', '--admin', '--password-stdin'], 'admin-password-1\n');
            assert.strictEqual(r.code, 0, r.err);
            assert.ok(/created user u_[a-z0-9]{12} \(admin\)/.test(r.out));
            r = await cli(dir, ['create-user', '--email', 'admin@example.com', '--name', 'Dup', '--password-stdin'], 'admin-password-1\n');
            assert.strictEqual(r.code, 1);
            r = await cli(dir, ['create-user', '--email', 'short@example.com', '--name', 'S', '--password-stdin'], 'short\n');
            assert.strictEqual(r.code, 1);
            r = await cli(dir, ['list-users']);
            assert.strictEqual(r.code, 0);
            assert.ok(r.out.includes('admin@example.com') && r.out.includes('admin'));
            assert.ok(!r.out.includes('scrypt$'), 'no hashes printed');
            r = await cli(dir, ['create-invite', '--count', '3', '--days', '2']);
            assert.strictEqual(r.code, 0);
            const codes = r.out.trim().split(/\r?\n/);
            assert.strictEqual(codes.length, 3);
            assert.ok(codes.every((c) => /^[A-Z2-7]{12}$/.test(c)));
            r = await cli(dir, ['disable-user', '--email', 'admin@example.com']);
            assert.strictEqual(r.code, 0);
            r = await cli(dir, ['backup', '--out', path.join(dir, 'backups', 'relay.db')]);
            assert.strictEqual(r.code, 0, r.err);

            const db = openDatabase(path.join(dir, 'backups', 'relay.db'));
            const u = db.get('SELECT * FROM users WHERE email = ?', 'admin@example.com');
            assert.strictEqual(u.is_admin, 1);
            assert.strictEqual(u.disabled, 1);
            assert.ok(await verifyPassword('admin-password-1', u.password_hash));
            assert.strictEqual(db.get('SELECT COUNT(*) AS n FROM invites').n, 3);
            assert.strictEqual(db.get('SELECT COUNT(*) AS n FROM session_revocations').n, 1);
            db.close();
            r = await cli(dir, ['nope']);
            assert.strictEqual(r.code, 1);
        } finally {
            removeDir(dir);
        }
    }],
    ['create-user without --admin: the first account becomes admin (D5), later ones do not', async () => {
        const dir = tmpDir();
        try {
            let r = await cli(dir, ['create-user', '--email', 'first@example.com', '--name', 'First', '--password-stdin'], 'first-password-1\n');
            assert.strictEqual(r.code, 0, r.err);
            assert.ok(/created user u_[a-z0-9]{12} \(admin\)/.test(r.out));
            assert.ok(r.out.includes('first account'));
            r = await cli(dir, ['create-user', '--email', 'second@example.com', '--name', 'Second', '--password-stdin'], 'second-password-1\n');
            assert.strictEqual(r.code, 0, r.err);
            assert.ok(!r.out.includes('(admin)'));
            const db = openDatabase(path.join(dir, 'relay.db'));
            assert.strictEqual(db.get('SELECT is_admin FROM users WHERE email = ?', 'first@example.com').is_admin, 1);
            assert.strictEqual(db.get('SELECT is_admin FROM users WHERE email = ?', 'second@example.com').is_admin, 0);
            db.close();
        } finally {
            removeDir(dir);
        }
    }],
]);
