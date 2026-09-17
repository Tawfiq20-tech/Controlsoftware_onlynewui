import { apiErrorText } from '../api.js';
import { field, h, withBusy } from '../ui.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function render(root, ctx) {
    const signup = ctx.config().signup;
    if (signup === 'closed') {
        root.append(h('section', { class: 'narrow' },
            h('h1', null, 'Create account'),
            h('p', { class: 'card' }, 'Sign-up is closed. Ask the relay administrator for an account.'),
            h('p', { class: 'center' }, h('a', { href: '#/login' }, 'Back to sign in'))));
        return null;
    }

    const email = h('input', { type: 'email', autocomplete: 'username', required: true, maxLength: 254, inputmode: 'email' });
    const displayName = h('input', { type: 'text', autocomplete: 'nickname', required: true, maxLength: 60 });
    const password = h('input', { type: 'password', autocomplete: 'new-password', required: true, maxLength: 200, minlength: '10' });
    const invite = signup === 'invite'
        ? h('input', { type: 'text', autocomplete: 'off', required: true, maxLength: 40, autocapitalize: 'characters', spellcheck: 'false' })
        : null;
    const error = h('p', { class: 'form-error', role: 'alert' });
    const submit = h('button', { type: 'submit', class: 'btn btn-primary btn-block' }, 'Create account');

    const form = h('form', { class: 'card form', novalidate: 'novalidate' },
        field('Email', email),
        field('Display name', displayName, 'Shown to people you share a machine with, and on the machine screen.'),
        field('Password', password, 'At least 10 characters.'),
        invite ? field('Invite code', invite) : null,
        error,
        submit);

    form.addEventListener('submit', (e) => {
        e.preventDefault();
        error.textContent = '';
        const payload = {
            email: email.value.trim().toLowerCase(),
            password: password.value,
            displayName: displayName.value.trim(),
        };
        if (!EMAIL_RE.test(payload.email)) { error.textContent = 'Enter a valid email address'; return; }
        if (payload.displayName.length < 1 || payload.displayName.length > 60) { error.textContent = 'Enter a display name (up to 60 characters)'; return; }
        if (payload.password.length < 10) { error.textContent = 'The password must be at least 10 characters'; return; }
        if (invite) {
            payload.inviteCode = invite.value.trim();
            if (!payload.inviteCode) { error.textContent = 'Enter your invite code'; return; }
        }
        withBusy(submit, async () => {
            try {
                const res = await ctx.api.register(payload);
                password.value = '';
                ctx.onLogin(res.user, res.csrfToken);
            } catch (err) {
                error.textContent = apiErrorText(err);
            }
        });
    });

    root.append(h('section', { class: 'narrow' },
        h('h1', null, 'Create account'),
        form,
        h('p', { class: 'center' }, 'Already have an account? ', h('a', { href: '#/login' }, 'Sign in'))));
    email.focus();
    return null;
}
