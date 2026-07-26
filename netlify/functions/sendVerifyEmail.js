const nodemailer = require('nodemailer');
const admin = require('firebase-admin');

if (!admin.apps.length) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: "https://b-talk-login-default-rtdb.firebaseio.com/"
    });
}
const db = admin.database();

// 이메일을 Firebase RTDB 키로 쓸 수 있도록 안전하게 치환 (.#$[] 금지 문자)
function emailToKey(email) {
    return email.trim().toLowerCase().replace(/[.#$[\]]/g, '_');
}

const headers = {
    'Access-Control-Allow-Origin': 'https://boundless-talk.github.io',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

exports.handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers: headers, body: '' };
    }
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, headers: headers, body: 'Method Not Allowed' };
    }

    const { email } = JSON.parse(event.body || '{}');
    if (!email) {
        return { statusCode: 400, headers: headers, body: JSON.stringify({ error: 'email required' }) };
    }

    if (!process.env.GMAIL_USER || !process.env.GMAIL_PASS) {
        return { statusCode: 500, headers: headers, body: JSON.stringify({ error: 'Email not configured' }) };
    }

    // 서버에서 인증 코드 생성 및 10분 유효기간으로 저장 (클라이언트는 코드를 알 수 없음)
    const code = String(Math.floor(100000 + Math.random() * 900000));
    try {
        await db.ref('emailVerifications/' + emailToKey(email)).set({
            code, expiresAt: Date.now() + 10 * 60 * 1000
        });
    } catch (e) {
        console.error('sendVerifyEmail DB write failed:', e.message);
        return { statusCode: 500, headers: headers, body: JSON.stringify({ error: 'Failed to store verification code' }) };
    }

    const transporter = nodemailer.createTransport({
        host: 'smtp.gmail.com',
        port: 465,
        secure: true,
        auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_PASS }
    });

    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f6;font-family:'Helvetica Neue',Arial,sans-serif;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">인증 코드: ${code} (10분간 유효)</div>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f6;padding:40px 0;">
    <tr><td align="center">
      <table width="440" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:14px;overflow:hidden;max-width:440px;border:1px solid #ececec;">
        <tr>
          <td align="center" style="padding:32px 40px 8px;">
            <span style="font-size:17px;font-weight:700;letter-spacing:-0.02em;color:#1a1a1a;">boundless talk</span>
          </td>
        </tr>
        <tr>
          <td align="center" style="padding:12px 40px 0;">
            <p style="color:#333333;font-size:15px;line-height:1.6;margin:0 0 4px;font-weight:600;">이메일 인증 코드를 보내드려요</p>
            <p style="color:#8a8a8a;font-size:13px;line-height:1.6;margin:0 0 24px;">아래 6자리 코드를 입력하면 인증이 완료됩니다.</p>
            <div style="background:#f9f4f2;border:1px solid #f0dbd6;border-radius:10px;padding:18px 0;width:100%;">
              <div style="font-size:30px;font-weight:700;letter-spacing:8px;color:#c8391f;">${code}</div>
            </div>
            <p style="color:#a8a8a8;font-size:12px;margin:16px 0 0;">10분 후 만료됩니다. 코드를 다른 사람과 공유하지 마세요.</p>
          </td>
        </tr>
        <tr>
          <td align="center" style="padding:24px 40px 28px;">
            <p style="color:#b5b5b5;font-size:11.5px;line-height:1.6;margin:0;border-top:1px solid #f0f0f0;padding-top:16px;">본인이 요청한 인증이 아니라면 이 메일을 무시하셔도 안전합니다.<br>이 메일은 boundless talk 이메일 인증을 위해 발송되었습니다.</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

    try {
        await transporter.sendMail({
            from: `"boundless talk" <${process.env.GMAIL_USER}>`,
            to: email,
            subject: `이메일 인증 코드가 도착했어요`,
            html
        });
        return { statusCode: 200, headers: headers, body: JSON.stringify({ ok: true }) };
    } catch (err) {
        console.error('sendVerifyEmail error:', err.message);
        return { statusCode: 500, headers: headers, body: JSON.stringify({ error: err.message }) };
    }
};
