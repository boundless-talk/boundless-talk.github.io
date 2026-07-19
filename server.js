const express = require('express');
const cors = require('cors');
const { RtcTokenBuilder, RtcRole } = require('agora-token');
const Busboy = require('busboy');
const OpenAI = require('openai');
const nodemailer = require('nodemailer');
const admin = require('firebase-admin');

// Gmail SMTP (Resend 샌드박스는 계정 소유자 본인 메일로만 발송 가능해서, 임의 수신자에게 보내려면 이쪽을 씀)
const gmailTransporter = (process.env.GMAIL_USER && process.env.GMAIL_PASS)
    ? nodemailer.createTransport({
        service: 'gmail',
        auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_PASS }
    })
    : null;

// Firebase Admin 초기화
let storageBucket;
if (!admin.apps.length && process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
        const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        admin.initializeApp({
            credential: admin.credential.cert(sa),
            databaseURL: 'https://b-talk-login-default-rtdb.firebaseio.com/',
            storageBucket: 'b-talk-login.firebasestorage.app'
        });
        console.log('Firebase Admin initialized');
        try { storageBucket = admin.storage().bucket(); } catch (e) { console.error('Storage bucket init failed:', e.message); }
    } catch (e) {
        console.error('Firebase Admin init failed:', e.message);
    }
}

// 1시간마다 만료된 waitlist 항목 정리
setInterval(async () => {
    if (!admin.apps.length) return;
    try {
        const db = admin.database();
        const snap = await db.ref('waitlist').once('value');
        const data = snap.val() || {};
        const now = Date.now();
        const updates = {};
        Object.entries(data).forEach(([kw, users]) => {
            if (!users) return;
            Object.entries(users).forEach(([uid, entry]) => {
                if (entry && entry.expiresAt < now) updates[`waitlist/${kw}/${uid}`] = null;
            });
        });
        if (Object.keys(updates).length > 0) await db.ref().update(updates);
    } catch (e) {
        console.error('Waitlist cleanup error:', e.message);
    }
}, 60 * 60 * 1000);

const app = express();
app.use(cors());

// ── Dodo Payments (구독 결제) ──
const DodoPaymentsSDK = require('dodopayments');
const DodoPayments = DodoPaymentsSDK.default || DodoPaymentsSDK;

const dodoClient = process.env.DODO_PAYMENTS_API_KEY
    ? new DodoPayments({
        bearerToken: process.env.DODO_PAYMENTS_API_KEY,
        webhookKey: process.env.DODO_PAYMENTS_WEBHOOK_KEY,
        environment: process.env.DODO_PAYMENTS_ENV || 'test_mode' // 실결제 전환 시 'live_mode'로 변경
    })
    : null;

// Dodo 대시보드에서 만든 구독 상품(Product)의 ID를 여기에 매핑
const DODO_PRODUCTS = {
    monthly: process.env.DODO_PRODUCT_MONTHLY,
    weekly: process.env.DODO_PRODUCT_WEEKLY
};

// 체크아웃 세션 생성 — 프론트엔드가 이 URL로 리다이렉트하면 Dodo 결제 페이지로 이동
app.post('/dodo/create-checkout', express.json(), async (req, res) => {
    if (!dodoClient) return res.status(503).json({ error: 'Dodo Payments not configured' });
    const { plan, uid, email } = req.body;
    if (!plan || !uid || !DODO_PRODUCTS[plan]) {
        return res.status(400).json({ error: 'Invalid plan or missing uid' });
    }
    try {
        const session = await dodoClient.checkoutSessions.create({
            product_cart: [{ product_id: DODO_PRODUCTS[plan], quantity: 1 }],
            customer: email ? { email } : undefined,
            return_url: 'https://boundless-talk.github.io/?payment=success',
            // metadata는 웹훅에서 그대로 돌려받으므로, uid/plan을 실어 보내면
            // 웹훅 처리 시 어떤 유저의 어떤 플랜인지 바로 알 수 있음
            metadata: { uid, plan }
        });
        res.json({ checkout_url: session.checkout_url });
    } catch (e) {
        console.error('[dodo/create-checkout] error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// 웹훅 — 결제 완료/갱신 시 Dodo가 이 URL로 이벤트를 보내면 Firebase에 구독 상태 반영
// 서명 검증을 위해 raw body가 필요하므로, 아래 express.json() 전역 미들웨어보다 먼저 선언하고
// 이 라우트에만 express.raw()를 사용함 (전역 json() 이 먼저 body를 파싱해버리면 서명 검증 불가)
app.post('/dodo/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    if (!dodoClient) return res.status(503).send('Dodo Payments not configured');

    let event;
    try {
        event = dodoClient.webhooks.unwrap(req.body.toString(), {
            headers: {
                'webhook-id': req.headers['webhook-id'],
                'webhook-signature': req.headers['webhook-signature'],
                'webhook-timestamp': req.headers['webhook-timestamp']
            }
        });
    } catch (e) {
        console.error('[dodo/webhook] signature verification failed:', e.message);
        return res.status(401).json({ error: 'Invalid signature' });
    }

    console.log('[dodo/webhook] event received:', JSON.stringify(event));

    try {
        const type = event.type || event.event_type || '';
        const data = event.data || {};
        const metadata = data.metadata || {};
        const uid = metadata.uid;
        const plan = metadata.plan;

        // 실제 이벤트 타입 이름은 위 로그로 확인 후 필요하면 이 정규식을 조정하세요
        const isGrantEvent = /active|renewed|succeeded/i.test(type);

        if (isGrantEvent && uid && plan && admin.apps.length) {
            const days = plan === 'monthly' ? 30 : 7;
            const expiresAt = new Date(Date.now() + days * 86400000).toISOString();
            const subscriptionId = data.subscription_id || data.id || null;
            await admin.database().ref('users/' + uid + '/subscription').set({ plan, expiresAt, subscriptionId });
            console.log(`[dodo/webhook] subscription granted: uid=${uid} plan=${plan} expiresAt=${expiresAt} subscriptionId=${subscriptionId}`);
        }
        res.json({ received: true });
    } catch (e) {
        console.error('[dodo/webhook] processing error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

app.use(express.json());

// ── 초기 회원 50명 프로모션 (가입 순서로 선착순, 30일간 하루 2시간 무료) ──
// subscription 필드는 Firebase 규칙상 관리자(서버)만 쓸 수 있으므로,
// 클라이언트가 uid를 그냥 보내는 게 아니라 ID 토큰을 검증해서 본인 확인 후 서버가 직접 부여함
const EARLY_ACCESS_LIMIT = 50;
app.post('/claim-early-access', async (req, res) => {
    if (!admin.apps.length) return res.status(503).json({ error: 'Firebase Admin not initialized' });
    const { idToken } = req.body;
    if (!idToken) return res.status(400).json({ error: 'idToken required' });

    let uid;
    try {
        const decoded = await admin.auth().verifyIdToken(idToken);
        uid = decoded.uid;
    } catch (e) {
        return res.status(401).json({ error: 'Invalid token' });
    }

    try {
        const db = admin.database();

        // 이미 유효한 구독(프로모션 포함)이 있으면 중복 부여 방지
        const subSnap = await db.ref('users/' + uid + '/subscription').once('value');
        const existing = subSnap.val();
        if (existing && existing.expiresAt && new Date(existing.expiresAt) > new Date()) {
            return res.json({ granted: false, reason: 'already_has_subscription' });
        }

        // 원자적 카운터 증가 (동시 가입에도 안전)
        const counterRef = db.ref('meta/early50Count');
        const txResult = await counterRef.transaction(v => (v || 0) + 1);
        const count = txResult.committed ? txResult.snapshot.val() : null;

        if (!count || count > EARLY_ACCESS_LIMIT) {
            return res.json({ granted: false, reason: 'limit_reached', count });
        }

        const expiresAt = new Date(Date.now() + 30 * 86400000).toISOString();
        await db.ref('users/' + uid + '/subscription').set({
            plan: 'early50',
            expiresAt,
            grantedAt: Date.now()
        });
        console.log(`[claim-early-access] granted: uid=${uid} count=${count}/${EARLY_ACCESS_LIMIT} expiresAt=${expiresAt}`);
        res.json({ granted: true, count, expiresAt });
    } catch (e) {
        console.error('[claim-early-access] error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ── 회원탈퇴 ──
// 신고/제재 이력(banned, suspendedUntil, warnedAt 등)은 남기고 나머지 개인 데이터만 지움.
// Auth 계정 자체도 삭제하므로 같은 이메일로는 재가입해야 재이용 가능.
const SANCTION_FIELDS = ['banned', 'bannedAt', 'banReason', 'suspendedUntil', 'suspendReason', 'warnedAt', 'lastReportReason', 'reportCount'];

app.post('/delete-account', async (req, res) => {
    if (!admin.apps.length) return res.status(503).json({ error: 'Firebase Admin not initialized' });
    const { idToken, reason } = req.body;
    if (!idToken) return res.status(400).json({ error: 'idToken required' });

    let uid, email;
    try {
        const decoded = await admin.auth().verifyIdToken(idToken);
        uid = decoded.uid;
        email = decoded.email || null;
    } catch (e) {
        return res.status(401).json({ error: 'Invalid token' });
    }

    try {
        const db = admin.database();
        const userRef = db.ref('users/' + uid);
        const snap = await userRef.once('value');
        const userData = snap.val() || {};

        // 유료 구독이 살아있으면 Dodo 쪽 구독도 취소 시도 (실패해도 탈퇴 자체는 계속 진행)
        const sub = userData.subscription;
        if (dodoClient && sub && sub.subscriptionId && sub.plan !== 'early50' && sub.expiresAt && new Date(sub.expiresAt) > new Date()) {
            try {
                await dodoClient.subscriptions.update(sub.subscriptionId, { status: 'cancelled' });
                console.log(`[delete-account] Dodo subscription cancelled: uid=${uid} subscriptionId=${sub.subscriptionId}`);
            } catch (e) {
                console.error(`[delete-account] Dodo subscription cancel failed (needs manual follow-up): uid=${uid} subscriptionId=${sub.subscriptionId} error=${e.message}`);
            }
        }

        // 탈퇴 사유 기록 (서비스 개선용)
        if (reason) {
            await db.ref('accountDeletions').push({
                uid, email, reason,
                deletedAt: new Date().toISOString()
            });
        }

        // 신고/제재 이력만 남기고 나머지 필드 삭제
        const preserved = {};
        SANCTION_FIELDS.forEach(f => { if (userData[f] !== undefined) preserved[f] = userData[f]; });
        preserved.accountDeleted = true;
        preserved.deletedAt = Date.now();
        await userRef.set(preserved);

        await admin.auth().deleteUser(uid);
        console.log(`[delete-account] account deleted: uid=${uid}`);
        res.json({ success: true });
    } catch (e) {
        console.error('[delete-account] error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

const APP_ID = process.env.AGORA_APP_ID;
const APP_CERTIFICATE = process.env.AGORA_APP_CERTIFICATE;
const TOKEN_EXPIRY_SEC = 3600;

app.get('/token', (req, res) => {
    const { channelName, uid } = req.query;

    if (!channelName || uid === undefined) {
        return res.status(400).json({ error: 'channelName and uid are required' });
    }

    if (!APP_ID || !APP_CERTIFICATE) {
        return res.status(500).json({ error: 'Server misconfigured' });
    }

    const currentTime = Math.floor(Date.now() / 1000);
    const privilegeExpireTime = currentTime + TOKEN_EXPIRY_SEC;

    const token = RtcTokenBuilder.buildTokenWithUid(
        APP_ID,
        APP_CERTIFICATE,
        channelName,
        parseInt(uid),
        RtcRole.PUBLISHER,
        privilegeExpireTime,
        privilegeExpireTime
    );

    res.json({ token });
});

app.post('/transcribe', (req, res) => {
    if (!process.env.OPENAI_API_KEY) {
        return res.status(500).json({ error: 'OPENAI_API_KEY not set' });
    }

    const bb = Busboy({ headers: req.headers });
    let audioBuffer = null;
    let audioMime = 'audio/webm';
    let lang = '';

    bb.on('file', (name, file, info) => {
        audioMime = info.mimeType || 'audio/webm';
        const chunks = [];
        file.on('data', chunk => chunks.push(chunk));
        file.on('close', () => { audioBuffer = Buffer.concat(chunks); });
    });

    bb.on('field', (name, val) => {
        if (name === 'lang') lang = val.split('-')[0];
    });

    bb.on('close', async () => {
        try {
            if (!audioBuffer || audioBuffer.length < 8000) {
                return res.json({ text: '' });
            }

            const ext = audioMime.includes('mp4') ? 'm4a' : 'webm';
            const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

            const transcription = await client.audio.transcriptions.create({
                file: await OpenAI.toFile(audioBuffer, `audio.${ext}`, { type: audioMime }),
                model: 'gpt-4o-mini-transcribe',
                language: lang || undefined
            });

            const raw = (transcription.text || '').trim();

            // Filter common Whisper hallucinations
            const hallucinations = [
                '시청해주셔서', '영상 봐주셔서', '영상봐주셔서', '오늘도 영상',
                '구독과 좋아요', '구독버튼', '좋아요버튼', '다음 영상에서 만나요',
                'thank you for watching', 'thanks for watching', 'please subscribe',
                'performance data collection', 'subtitles by', 'like and subscribe'
            ];
            const isHallucination = hallucinations.some(h => raw.toLowerCase().includes(h.toLowerCase()));
            const text = isHallucination ? '' : raw;

            res.json({ text });
        } catch (err) {
            console.error('Transcription error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    req.pipe(bb);
});

app.post('/summarize', (req, res) => {
    if (!process.env.GEMINI_API_KEY) {
        return res.status(500).json({ error: 'GEMINI_API_KEY not set' });
    }

    const bb = Busboy({ headers: req.headers });
    let audioBuffer = null;
    let audioMime = 'audio/webm';
    let lang = 'ko';

    bb.on('file', (name, file, info) => {
        audioMime = info.mimeType || 'audio/webm';
        const chunks = [];
        file.on('data', chunk => chunks.push(chunk));
        file.on('close', () => { audioBuffer = Buffer.concat(chunks); });
    });

    bb.on('field', (name, val) => {
        if (name === 'lang') lang = val;
    });

    bb.on('close', async () => {
        try {
            if (!audioBuffer) {
                return res.status(400).json({ error: '오디오 파일이 없습니다.' });
            }

            const prompt = lang === 'ko'
                ? '이 음성 대화를 듣고 주요 내용을 3문장 이내로 요약해 주세요. 대화가 아니라면 "소음만 감지되었습니다"라고 응답해 주세요.'
                : 'Listen to this conversation and summarize the main points in under 3 sentences. If there is no speech, reply with "Only noise detected."';

            const geminiRes = await fetch(
                `https://generativelanguage.googleapis.com/v1/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: [{
                            parts: [
                                { text: prompt },
                                { inline_data: { mime_type: audioMime, data: audioBuffer.toString('base64') } }
                            ]
                        }]
                    })
                }
            );

            const geminiData = await geminiRes.json();
            const summary = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '';
            res.json({ summary });
        } catch (err) {
            console.error('Summarize error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    req.pipe(bb);
});

app.post('/reportUser', (req, res) => {
    const bb = Busboy({ headers: req.headers });
    const chunks = [];
    let fields = {};

    bb.on('file', (name, file) => {
        file.on('data', chunk => chunks.push(chunk));
    });

    bb.on('field', (name, val) => { fields[name] = val; });

    bb.on('close', async () => {
        const audioBuffer = Buffer.concat(chunks);
        const { reportedUid, reporterUid, channel, reason } = fields;

        if (!reportedUid) {
            return res.status(400).json({ error: 'Missing reportedUid' });
        }

        const hasAudio = audioBuffer.length > 0;
        let audioStorageUrl = null;
        let aiResult = null;

        // 1. Storage 저장 (실패해도 계속)
        if (hasAudio && storageBucket) {
            try {
                const storagePath = `reports/${reportedUid}/${Date.now()}.webm`;
                const file = storageBucket.file(storagePath);
                await file.save(audioBuffer, { metadata: { contentType: 'audio/webm' } });
                const [signedUrl] = await file.getSignedUrl({
                    action: 'read',
                    expires: Date.now() + 7 * 24 * 60 * 60 * 1000
                });
                audioStorageUrl = signedUrl;
            } catch (e) { console.error('[reportUser] storage error:', e.message); }
        }

        // 2. Gemini AI 유해성 분석 (실패해도 계속)
        if (hasAudio && process.env.GEMINI_API_KEY) {
            try {
                const prompt = '이 음성 채팅 대화에 심한 욕설, 성희롱, 혐오 발언이 포함되어 있는지 판별하세요. JSON으로만 응답: {"isToxic": true/false, "reason": "간단한 이유"}';
                const geminiRes = await fetch(
                    `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
                    {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            contents: [{
                                parts: [
                                    { text: prompt },
                                    { inline_data: { mime_type: 'audio/webm', data: audioBuffer.toString('base64') } }
                                ]
                            }]
                        })
                    }
                );
                const geminiData = await geminiRes.json();
                const text = (geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
                const jsonMatch = text.match(/\{[\s\S]*\}/);
                if (jsonMatch) aiResult = JSON.parse(jsonMatch[0]);
            } catch (e) { console.error('[reportUser] Gemini error:', e.message); }
        }

        // 3. Firebase DB 저장 (항상 실행)
        if (!admin.apps.length) {
            return res.status(503).json({ error: 'Firebase Admin not initialized' });
        }
        try {
            const db = admin.database();
            await db.ref('reports').push({
                reporterUid: reporterUid || null,
                reportedUid,
                channel: channel || null,
                reason: reason || (aiResult ? aiResult.reason : null) || null,
                isToxic: aiResult ? aiResult.isToxic : null,
                audioUrl: audioStorageUrl,
                hasAudio,
                submittedAt: Date.now(),
                resolved: false
            });

            // 4. 유해성 감지 시 제재 (경고 → 24시간 정지 → 영구 정지)
            if (aiResult && aiResult.isToxic) {
                const userRef = db.ref('users/' + reportedUid);
                const snap = await userRef.once('value');
                const userData = snap.val() || {};
                const reportCount = (userData.reportCount || 0) + 1;
                const now = Date.now();

                if (reportCount === 1) {
                    await userRef.update({ reportCount, warnedAt: now, lastReportReason: aiResult.reason });
                } else if (reportCount === 2) {
                    await userRef.update({ reportCount, suspendedUntil: now + 86400000, suspendReason: aiResult.reason, lastReportReason: aiResult.reason });
                } else {
                    await userRef.update({ reportCount, banned: true, bannedAt: now, banReason: aiResult.reason });
                }
            }

            res.json({ success: true, toxic: aiResult ? aiResult.isToxic : false });
        } catch (e) {
            console.error('[reportUser] DB error:', e.message);
            res.status(500).json({ error: 'DB write failed' });
        }
    });

    req.pipe(bb);
});

app.post('/getTopic', async (req, res) => {
    if (!process.env.GEMINI_API_KEY) {
        return res.status(500).json({ error: 'GEMINI_API_KEY not set' });
    }

    const { topic } = req.body;
    if (!topic) return res.status(400).json({ error: 'topic required' });

    try {
        const geminiRes = await fetch(
            `https://generativelanguage.googleapis.com/v1/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{
                        parts: [{ text: `Translate or normalize this topic into one simple English word (lowercase, no spaces, no punctuation). Similar or synonymous topics must map to the same word. Examples: 사랑->love, 행복->happiness, 연애->love, 음악->music, 여행->travel. Output only the single English word, nothing else.\n\nTopic: ${topic.trim()}` }]
                    }],
                    generationConfig: { maxOutputTokens: 10, temperature: 0 }
                })
            }
        );

        const data = await geminiRes.json();
        const raw = data.candidates?.[0]?.content?.parts?.[0]?.text;
        console.log('Gemini response:', JSON.stringify(data));
        let normalized = (raw || '').trim().toLowerCase();
        normalized = normalized.replace(/[^a-z0-9_]/g, '').slice(0, 64) || 'general';
        res.json({ topic: normalized, debug_raw: raw, debug_status: geminiRes.status, debug_error: data.error });
    } catch (err) {
        console.error('getTopic error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get('/listmodels', async (req, res) => {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1/models?key=${process.env.GEMINI_API_KEY}`);
    const d = await r.json();
    res.json(d);
});

// 이메일을 Firebase RTDB 키로 쓸 수 있도록 안전하게 치환 (.#$[] 금지 문자)
function emailToKey(email) {
    return email.trim().toLowerCase().replace(/[.#$[\]]/g, '_');
}

app.post('/sendVerifyEmail', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'email required' });
    if (!gmailTransporter) {
        return res.status(500).json({ error: 'Email not configured' });
    }
    if (!admin.apps.length) {
        return res.status(503).json({ error: 'Firebase Admin not initialized' });
    }

    // 서버에서 인증 코드 생성 및 10분 유효기간으로 저장 (클라이언트는 코드를 알 수 없음)
    const code = String(Math.floor(100000 + Math.random() * 900000));
    try {
        await admin.database().ref('emailVerifications/' + emailToKey(email)).set({
            code, expiresAt: Date.now() + 10 * 60 * 1000
        });
    } catch (e) {
        console.error('sendVerifyEmail DB write failed:', e.message);
        return res.status(500).json({ error: 'Failed to store verification code' });
    }

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
        const info = await gmailTransporter.sendMail({
            from: `BOUNDLESS TALK <${process.env.GMAIL_USER}>`,
            to: email,
            subject: `[BOUNDLESS TALK] 이메일 인증 코드: ${code}`,
            html
        });
        console.log('sendVerifyEmail sent via Gmail, messageId:', info.messageId);
        res.json({ ok: true });
    } catch (err) {
        console.error('sendVerifyEmail Gmail error:', err.message);
        res.status(502).json({ error: err.message });
    }
});

app.post('/verifyEmailCode', async (req, res) => {
    const { email, code } = req.body;
    if (!email || !code) return res.status(400).json({ error: 'email and code required' });
    if (!admin.apps.length) return res.status(503).json({ error: 'Firebase Admin not initialized' });

    try {
        const ref = admin.database().ref('emailVerifications/' + emailToKey(email));
        const snap = await ref.once('value');
        const data = snap.val();

        if (!data) return res.json({ ok: false, error: 'invalid_code' });
        if (data.expiresAt < Date.now()) {
            await ref.remove();
            return res.json({ ok: false, error: 'code_expired' });
        }
        if (String(data.code) !== String(code)) {
            return res.json({ ok: false, error: 'invalid_code' });
        }

        await ref.remove(); // 1회용 코드
        res.json({ ok: true });
    } catch (err) {
        console.error('verifyEmailCode error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// 대기 중인 사용자에게 FCM 푸시 발송
app.post('/push/notify', async (req, res) => {
    if (!admin.apps.length) return res.status(503).json({ error: 'Firebase Admin not initialized' });
    const { keyword, topic } = req.body;
    const normalizedKw = keyword || topic;
    if (!normalizedKw) return res.status(400).json({ error: 'keyword required' });

    try {
        const db = admin.database();
        const snap = await db.ref(`waitlist/${normalizedKw}`).once('value');
        const users = snap.val() || {};
        const now = Date.now();

        const valid = [];
        const expiredUids = [];
        Object.entries(users).forEach(([uid, entry]) => {
            if (!entry) return;
            if (entry.expiresAt < now) expiredUids.push(uid);
            else if (entry.fcmToken) valid.push({ uid, token: entry.fcmToken });
        });

        for (const uid of expiredUids) await db.ref(`waitlist/${normalizedKw}/${uid}`).remove();

        if (valid.length === 0) return res.json({ notified: 0 });

        const message = {
            notification: {
                title: '딩동! 은하수를 건너온 신호 🌌',
                body: `당신이 남겨둔 #${normalizedKw} 에 누군가 따뜻한 온기를 더했습니다. 스쳐 지나가기 전에 지금 대화를 시작해 볼까요?`
            },
            data: { topic: String(normalizedKw) },
            tokens: valid.map(v => v.token)
        };

        const result = await admin.messaging().sendEachForMulticast(message);

        for (let i = 0; i < result.responses.length; i++) {
            if (result.responses[i].success) {
                await db.ref(`waitlist/${normalizedKw}/${valid[i].uid}`).remove();
            }
        }

        res.json({ notified: result.successCount });
    } catch (err) {
        console.error('push/notify error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.post('/translate', async (req, res) => {
    const { text, from, to } = req.body;
    if (!text || !from || !to) return res.status(400).json({ error: 'Missing params' });
    if (!process.env.DEEPL_API_KEY) return res.status(503).json({ error: 'No API key' });
    try {
        const r = await fetch('https://api-free.deepl.com/v2/translate', {
            method: 'POST',
            headers: { 'Authorization': 'DeepL-Auth-Key ' + process.env.DEEPL_API_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: [text], source_lang: from.toUpperCase(), target_lang: to.toUpperCase() })
        });
        const data = await r.json();
        const translated = data.translations?.[0]?.text || text;
        res.json({ translated });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`B-Talk server running on port ${PORT}`));
