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

    const { email } = JSON.parse(event.body || '{}');
    if (!email) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'email required' }) };
    }

    if (!process.env.GMAIL_USER || !process.env.GMAIL_PASS) {
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'Email not configured' }) };
    }

    // 서버에서 코드 생성 및 Firebase에 저장 (10분 만료)
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = Date.now() + 10 * 60 * 1000;
    const safeEmailKey = email.replace(/[.#$[\]]/g, '_');

    await db.ref('emailVerifyCodes/' + safeEmailKey).set({ code, expiresAt });

    const transporter = nodemailer.createTransport({
        host: 'smtp.gmail.com',
        port: 465,
        secure: true,
        auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_PASS }
    });

    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#0d0e12;font-family:'Helvetica Neue',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0d0e12;padding:40px 0;">
    <tr><td align="center">
      <table width="480" cellpadding="0" cellspacing="0" style="background:#16181f;border-radius:16px;overflow:hidden;max-width:480px;">
        <tr>
          <td align="center" style="padding:36px 40px 24px;">
            <div style="font-size:22px;font-weight:800;letter-spacing:3px;color:#ffffff;">BOUNDLESS TALK</div>
            <div style="width:40px;height:2px;background:#00e5ff;margin:10px auto 0;border-radius:2px;"></div>
          </td>
        </tr>
        <tr>
          <td align="center" style="padding:0 40px 28px;">
            <p style="color:rgba(255,255,255,0.55);font-size:14px;line-height:1.7;margin:0 0 28px;">
              아래 인증 코드를 입력하여 이메일 인증을 완료해 주세요.<br>
              <span style="font-size:12px;color:rgba(255,255,255,0.3);">Enter the code below to verify your email.</span>
            </p>
            <div style="background:#0d0e12;border:1.5px solid rgba(0,229,255,0.3);border-radius:12px;padding:22px 40px;display:inline-block;">
              <div style="font-size:36px;font-weight:700;letter-spacing:10px;color:#00e5ff;">${code}</div>
            </div>
            <p style="color:rgba(255,255,255,0.25);font-size:11px;margin:20px 0 0;">이 코드는 10분간 유효합니다 · Valid for 10 minutes</p>
          </td>
        </tr>
        <tr>
          <td align="center" style="padding:20px 40px 32px;border-top:1px solid rgba(255,255,255,0.06);">
            <p style="color:rgba(255,255,255,0.2);font-size:11px;margin:0;">본인이 요청하지 않았다면 이 메일을 무시해 주세요.<br>If you didn't request this, please ignore this email.</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

    try {
        await transporter.sendMail({
            from: `"BOUNDLESS TALK" <${process.env.GMAIL_USER}>`,
            to: email,
            subject: `[BOUNDLESS TALK] 이메일 인증 코드: ${code}`,
            html
        });
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    } catch (err) {
        console.error('sendVerifyEmail error:', err.message);
        return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
    }
};
