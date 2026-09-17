'use strict';

function parseCookies(header) {
    const out = Object.create(null);
    if (typeof header !== 'string' || !header) return out;
    for (const part of header.split(';')) {
        const idx = part.indexOf('=');
        if (idx <= 0) continue;
        const name = part.slice(0, idx).trim();
        let value = part.slice(idx + 1).trim();
        if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
        if (!(name in out)) {
            try {
                out[name] = decodeURIComponent(value);
            } catch (_) {
                out[name] = value;
            }
        }
    }
    return out;
}

function serializeCookie(name, value, { httpOnly = true, secure = false, sameSite = 'Strict', path = '/', maxAge } = {}) {
    let s = `${name}=${encodeURIComponent(value)}`;
    if (httpOnly) s += '; HttpOnly';
    if (secure) s += '; Secure';
    if (sameSite) s += `; SameSite=${sameSite}`;
    if (path) s += `; Path=${path}`;
    if (maxAge != null) s += `; Max-Age=${Math.floor(maxAge)}`;
    return s;
}

// Cookie names depend on transport: the __Host- prefix requires Secure, which a
// loopback http:// dev relay cannot set (§4.2).
function cookieNames(allowInsecure) {
    return allowInsecure
        ? { session: 'ors', knownDevice: 'ord' }
        : { session: '__Host-ors', knownDevice: '__Host-ord' };
}

function sessionCookie(token, allowInsecure) {
    const { session } = cookieNames(allowInsecure);
    if (allowInsecure) return serializeCookie(session, token, {});
    return serializeCookie(session, token, { secure: true, maxAge: 1209600 });
}

function clearSessionCookie(allowInsecure) {
    const { session } = cookieNames(allowInsecure);
    return serializeCookie(session, '', { secure: !allowInsecure, maxAge: 0 });
}

function knownDeviceCookie(value, allowInsecure) {
    const { knownDevice } = cookieNames(allowInsecure);
    return serializeCookie(knownDevice, value, { secure: !allowInsecure, maxAge: 180 * 86400 });
}

function appendSetCookie(res, cookie) {
    const prev = res.getHeader('Set-Cookie');
    if (!prev) res.setHeader('Set-Cookie', [cookie]);
    else res.setHeader('Set-Cookie', [].concat(prev, cookie));
}

module.exports = {
    parseCookies, serializeCookie, cookieNames, sessionCookie, clearSessionCookie, knownDeviceCookie, appendSetCookie,
};
