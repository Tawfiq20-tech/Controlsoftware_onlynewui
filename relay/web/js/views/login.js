import { apiErrorText } from '../api.js';
import { field, h, withBusy } from '../ui.js';

export function render(root, ctx) {
    const email = h('input', { type: 'email', name: 'email', autocomplete: 'username', required: true, maxLength: 254, inputmode: 'email' });
    const password = h('input', { type: 'password', name: 'password', autocomplete: 'current-password', required: true, maxLength: 200 });
    const error = h('p', { class: 'form-error', role: 'alert' });
    const submit = h('button', { type: 'submit', class: 'btn btn-primary btn-block' }, 'Sign in');

    const form = h('form', { class: 'card form', novalidate: 'novalidate' },
        field('Email', email),
        field('Password', password),
        error,
        submit);

    form.addEventListener('submit', (e) => {
        e.preventDefault();
        error.textContent = '';
        if (!email.value.trim() || !password.value) {
            error.textContent = 'Enter your email and password';
            return;
        }
        withBusy(submit, async () => {
            try {
                const res = await ctx.api.login(email.value.trim(), password.value);
                password.value = '';
                ctx.onLogin(res.user, res.csrfToken);
            } catch (err) {
                error.textContent = apiErrorText(err);
            }
        });
    });

    const signup = ctx.config().signup;
    root.append(h('section', { class: 'narrow' },
        h('h1', null, 'Sign in'),
        h('p', { class: 'lead' }, 'Monitor and control your Onefinity machine from anywhere.'),
        form,
        signup !== 'closed'
            ? h('p', { class: 'center' }, 'No account yet? ', h('a', { href: '#/register' }, 'Create one'))
            : h('p', { class: 'center muted' }, 'Accounts are created by the relay administrator.')));
    email.focus();
    return null;
}
