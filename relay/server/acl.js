'use strict';

const ROLE_RANK = Object.freeze({ viewer: 0, operator: 1, owner: 2 });

const CLS_BY_ROLE = Object.freeze({
    owner: Object.freeze(['stop', 'job', 'motion', 'monitor']),
    operator: Object.freeze(['stop', 'job', 'motion', 'monitor']),
    viewer: Object.freeze(['stop', 'monitor']),
});

class Acl {
    constructor({ db }) {
        this.db = db;
    }

    // Returns the role only for an enabled user on an active, enabled device. Everything
    // else (unknown, pending_confirmation, disabled, no grant) is indistinguishable: null.
    role(userId, deviceId) {
        if (typeof deviceId !== 'string' || !/^d_[a-z0-9]{12}$/.test(deviceId)) return null;
        const row = this.db.get(
            `SELECT g.role FROM grants g
               JOIN users u ON u.id = g.user_id
               JOIN devices d ON d.id = g.device_id
              WHERE g.user_id = ? AND g.device_id = ? AND u.disabled = 0 AND d.disabled = 0 AND d.status = 'active'`,
            userId, deviceId,
        );
        return row ? row.role : null;
    }

    atLeast(role, minRole) {
        return role != null && ROLE_RANK[role] >= ROLE_RANK[minRole];
    }

    allowsCls(role, cls) {
        return !!role && CLS_BY_ROLE[role].includes(cls);
    }
}

module.exports = { Acl, ROLE_RANK, CLS_BY_ROLE };
