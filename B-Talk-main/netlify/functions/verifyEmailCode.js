const admin = require('firebase-admin');

if (!admin.apps.length) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: "https://b-talk-login-default-rtdb.firebaseio.com/"
    });
}

const db = admin.database();

const headers = {
    'Access-Control-Allow-Origin': 'https://boundless-talk.github.io',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

exports.handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers, body: '' };
    }
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, headers, body: 'Method Not Allowed' };
    }

    const { email, code } = JSON.parse(event.body || '{}');
    if (!email || !code) {
        return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'email and code required' }) };
    }

    const safeEmailKey = email.replace(/[.#$[\]]/g, '_');
    const snap = await db.ref('emailVerifyCodes/' + safeEmailKey).once('value');
    const stored = snap.val();

    if (!stored) {
        return { statusCode: 200, headers, body: JSON.stringify({ ok: false, error: 'code_not_found' }) };
    }
    if (Date.now() > stored.expiresAt) {
        await db.ref('emailVerifyCodes/' + safeEmailKey).remove();
        return { statusCode: 200, headers, body: JSON.stringify({ ok: false, error: 'code_expired' }) };
    }
    if (stored.code !== code) {
        return { statusCode: 200, headers, body: JSON.stringify({ ok: false, error: 'code_mismatch' }) };
    }

    // 인증 성공 — 즉시 삭제 (재사용 방지)
    await db.ref('emailVerifyCodes/' + safeEmailKey).remove();
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
};
