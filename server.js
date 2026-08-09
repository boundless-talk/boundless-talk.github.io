const express = require('express');
const cors = require('cors');
const { RtcTokenBuilder, RtcRole } = require('agora-token');
const Busboy = require('busboy');
const OpenAI = require('openai');
const nodemailer = require('nodemailer');
const admin = require('firebase-admin');

// admin.html과 동일한 관리자 목록 — 여기 없는 계정은 예약방 삭제 등 관리자 전용 엔드포인트를 쓸 수 없음
const ADMIN_UIDS = new Set(['Gtm5D4E4eOXuUbYWnT94QV9dXRq2']);
const ADMIN_EMAILS = new Set(['freesia9353@gmail.com']);

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

// 매일 저녁 9시(21:00 KST)에 그날 예약된 대화방들의 좌석 예약자 전원에게 알림 발송
// — 자리가 다 안 찼어도 예약한 사람들에게는 그대로 알림이 감. 1분마다 확인, 하루 한 번만 실행
let _lastScheduledNotifyDate = null;
setInterval(async () => {
    if (!admin.apps.length) return;
    try {
        const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
        const kstHour = kst.getUTCHours();
        const kstMinute = kst.getUTCMinutes();
        const todayKey = kst.toISOString().slice(0, 10);
        if (kstHour !== 21 || kstMinute > 1) return;
        if (_lastScheduledNotifyDate === todayKey) return;
        _lastScheduledNotifyDate = todayKey;

        const db = admin.database();
        const snap = await db.ref(`scheduledRooms/${todayKey}`).once('value');
        const data = snap.val() || {};
        const rooms = Object.values(data).filter(r => r && r.title && r.seats);

        const sendPromises = [];
        rooms.forEach(room => {
            Object.values(room.seats).forEach(seat => {
                if (!seat || !seat.fcmToken) return;
                sendPromises.push(admin.messaging().send({
                    token: seat.fcmToken,
                    notification: {
                        title: '🌙 대화의 문이 열렸어요',
                        body: `예약하신 "${room.title}" 방을 시작해보세요!`
                    },
                    data: {
                    topic: String(room.title),
                    style: room.style === 'polite' ? 'polite' : 'casual',
                    pp: room.pingpong ? '1' : '0'
                }
                }));
            });
        });
        if (sendPromises.length === 0) return;

        const results = await Promise.allSettled(sendPromises);
        const sent = results.filter(r => r.status === 'fulfilled').length;
        console.log(`[scheduled notify] ${sent}/${sendPromises.length} sent for ${todayKey}`);
    } catch (e) {
        console.error('Scheduled notify error:', e.message);
    }
}, 60 * 1000);

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

// 오늘 다녀간 순 방문자 수 — 클라이언트 쪽 DB 보안 규칙에 막힐 수 있어 Admin SDK로 읽고/씀
function todayKstDateKey() {
    const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
    return `${kst.getUTCFullYear()}-${String(kst.getUTCMonth() + 1).padStart(2, '0')}-${String(kst.getUTCDate()).padStart(2, '0')}`;
}
app.get('/dailyVisitors', async (req, res) => {
    if (!admin.apps.length) return res.json({ count: 0 });
    try {
        const snap = await admin.database().ref('stats/dailyVisitors/' + todayKstDateKey()).once('value');
        const val = snap.val();
        res.json({ count: val ? Object.keys(val).length : 0 });
    } catch (e) {
        console.error('[dailyVisitors] error:', e.message);
        res.status(500).json({ count: 0 });
    }
});
app.post('/dailyVisitors/record', async (req, res) => {
    if (!admin.apps.length) return res.json({ count: 0 });
    const { uid } = req.body;
    if (!uid) return res.status(400).json({ error: 'uid required' });
    try {
        const dateRef = admin.database().ref('stats/dailyVisitors/' + todayKstDateKey());
        await dateRef.child(uid).set(true);
        const snap = await dateRef.once('value');
        const val = snap.val();
        res.json({ count: val ? Object.keys(val).length : 0 });
    } catch (e) {
        console.error('[dailyVisitors/record] error:', e.message);
        res.status(500).json({ count: 0 });
    }
});

// 로그인 전 화면에서 "선착순 N명 남음" 안내에 쓰는 잔여 수량 조회 (인증 불필요, 숫자만 공개)
app.get('/early50-remaining', async (req, res) => {
    if (!admin.apps.length) return res.json({ remaining: 0 });
    try {
        const snap = await admin.database().ref('meta/early50Count').once('value');
        const count = snap.val() || 0;
        res.json({ remaining: Math.max(0, EARLY_ACCESS_LIMIT - count) });
    } catch (e) {
        console.error('[early50-remaining] error:', e.message);
        res.status(500).json({ remaining: 0 });
    }
});

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

// 운영시간 외 "저녁 9시 대화방 예약(Scheduled)" — Admin SDK로 대신 써서 클라이언트 DB 규칙에 안 걸리게 함
app.post('/create-scheduled-room', async (req, res) => {
    if (!admin.apps.length) return res.status(503).json({ error: 'Firebase Admin not initialized' });
    const { idToken, title, category, style, pingpong, fcmToken } = req.body;
    if (!idToken || !title) return res.status(400).json({ error: 'idToken, title required' });

    let uid;
    try {
        uid = (await admin.auth().verifyIdToken(idToken)).uid;
    } catch (e) {
        return res.status(401).json({ error: 'Invalid token' });
    }

    try {
        const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
        const today = kst.toISOString().slice(0, 10);
        const roomId = 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        const roomRef = admin.database().ref(`scheduledRooms/${today}/${roomId}`);
        await roomRef.set({
            title: String(title).slice(0, 200),
            category: String(category || 'general').slice(0, 32),
            style: style === 'polite' ? 'polite' : 'casual',
            pingpong: !!pingpong,
            createdAt: Date.now(),
            createdBy: uid,
            seats: { [uid]: { fcmToken: fcmToken || null, joinedAt: Date.now() } }
        });
        res.json({ success: true, roomId });
    } catch (e) {
        console.error('[create-scheduled-room] error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// 예약방 좌석 참가 — 마지막 자리를 두 명이 동시에 채우는 경쟁 상태를 막기 위해 seats 노드에 트랜잭션을 검
app.post('/join-scheduled-room', async (req, res) => {
    if (!admin.apps.length) return res.status(503).json({ error: 'Firebase Admin not initialized' });
    const { idToken, roomId, fcmToken } = req.body;
    if (!idToken || !roomId) return res.status(400).json({ error: 'idToken, roomId required' });

    let uid;
    try {
        uid = (await admin.auth().verifyIdToken(idToken)).uid;
    } catch (e) {
        return res.status(401).json({ error: 'Invalid token' });
    }

    try {
        const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
        const today = kst.toISOString().slice(0, 10);
        const roomRef = admin.database().ref(`scheduledRooms/${today}/${roomId}`);

        const titleSnap = await roomRef.child('title').once('value');
        if (!titleSnap.exists()) return res.json({ success: false, full: false, error: 'room_not_found' });

        let outcome = 'joined'; // 'joined' | 'full' | 'already'
        await roomRef.child('seats').transaction(currentSeats => {
            const seats = currentSeats || {};
            if (seats[uid]) { outcome = 'already'; return seats; }
            if (Object.keys(seats).length >= 4) { outcome = 'full'; return seats; }
            outcome = 'joined';
            return { ...seats, [uid]: { fcmToken: fcmToken || null, joinedAt: Date.now() } };
        });

        res.json({ success: outcome !== 'full', full: outcome === 'full' });
    } catch (e) {
        console.error('[join-scheduled-room] error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

app.post('/leave-scheduled-room', async (req, res) => {
    if (!admin.apps.length) return res.status(503).json({ error: 'Firebase Admin not initialized' });
    const { idToken, roomId } = req.body;
    if (!idToken || !roomId) return res.status(400).json({ error: 'idToken, roomId required' });

    let uid;
    try {
        uid = (await admin.auth().verifyIdToken(idToken)).uid;
    } catch (e) {
        return res.status(401).json({ error: 'Invalid token' });
    }

    try {
        const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
        const today = kst.toISOString().slice(0, 10);
        const roomRef = admin.database().ref(`scheduledRooms/${today}/${roomId}`);
        await roomRef.child('seats/' + uid).remove();

        // 좌석이 하나도 안 남으면 빈 예약방이 남지 않게 방 자체를 지움
        const seatsSnap = await roomRef.child('seats').once('value');
        if (!seatsSnap.exists() || seatsSnap.numChildren() === 0) {
            await roomRef.remove();
        }
        res.json({ success: true });
    } catch (e) {
        console.error('[leave-scheduled-room] error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// 오늘 예약된 방 목록 — idToken을 주면 내가 참여 중인지(joined) 여부도 같이 내려줌
app.post('/scheduled-rooms-today', async (req, res) => {
    if (!admin.apps.length) return res.json({ rooms: [] });
    const { idToken } = req.body || {};
    let uid = null;
    if (idToken) {
        try { uid = (await admin.auth().verifyIdToken(idToken)).uid; } catch (e) { uid = null; }
    }
    try {
        const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
        const today = kst.toISOString().slice(0, 10);
        const snap = await admin.database().ref(`scheduledRooms/${today}`).once('value');
        const data = snap.val() || {};
        const rooms = Object.entries(data).map(([id, r]) => {
            const seats = r.seats || {};
            return {
                id,
                title: r.title,
                category: r.category || 'general',
                style: r.style === 'polite' ? 'polite' : 'casual',
                pingpong: !!r.pingpong,
                seatCount: Object.keys(seats).length,
                maxPeople: 4,
                joined: uid ? !!seats[uid] : false
            };
        });
        res.json({ rooms });
    } catch (e) {
        console.error('[scheduled-rooms-today] error:', e.message);
        res.json({ rooms: [] });
    }
});

// ══════════════════════════════════════════════════════════════════════════
//  새 방 시스템 (rooms) — 운영시간·예약방을 대체
//
//  기존 scheduledRooms가 "저녁 9시 하나로 고정"이었던 것을 일반화한 구조.
//    startAt === null  →  "지금 바로" 방. 빈 방에 누가 들어오면 참여자에게 알림.
//    startAt === 시각   →  "시간 지정" 방. 참여자가 늘 때 / 5분 전 / 시작 시각에 알림.
//
//  방은 접속자가 없어도 사라지지 않는 것이 핵심. 그래야 시간이 어긋난 사람들도 만난다.
//  기존 scheduledRooms 엔드포인트는 그대로 두어, 이미 잡힌 예약이 소진될 때까지 함께 돈다.
// ══════════════════════════════════════════════════════════════════════════

const ROOM_MAX_PEOPLE = 4;        // 정원 = 알림 대상 상한
const ROOM_DAILY_PUSH_CAP = 2;    // 한 방에서 한 사람에게 하루 최대 몇 통까지
const ROOM_SCHEDULE_MAX_MS = 24 * 60 * 60 * 1000;  // 약속은 24시간 이내로만
const ROOM_LIVE_TTL_MS = 24 * 60 * 60 * 1000;      // "지금" 방: 만든 지 24시간
const ROOM_AFTER_START_TTL_MS = 2 * 60 * 60 * 1000; // "지정" 방: 약속 시각 + 2시간

function kstDayKey(ms) {
    return new Date((ms || Date.now()) + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// FCM 발송. 하루 상한을 넘긴 사람은 건너뛰고, 보낸 사람의 카운터를 올려준다.
// 알림 하나 실패했다고 요청 전체가 죽으면 안 되므로 개별 실패는 삼킨다.
async function pushToParticipants(roomId, room, targetUids, title, body) {
    if (!admin.apps.length) return 0;
    const participants = room.participants || {};
    const today = kstDayKey();
    const sends = [];
    const bumps = {};

    targetUids.forEach(uid => {
        const p = participants[uid];
        if (!p || !p.fcmToken) return;
        const used = (p.nDate === today) ? (p.nCount || 0) : 0;
        if (used >= ROOM_DAILY_PUSH_CAP) return;   // 알림 피로 방지
        bumps[uid] = { nDate: today, nCount: used + 1 };
        sends.push(
            admin.messaging().send({
                token: p.fcmToken,
                notification: { title: title, body: body },
                data: {
                    roomId: String(roomId),
                    topic: String(room.title || ''),
                    style: room.style === 'polite' ? 'polite' : 'casual',
                    pp: room.pingpong ? '1' : '0'
                }
            }).catch(e => { console.warn('[rooms push]', uid, e.message); return null; })
        );
    });

    if (!sends.length) return 0;
    const results = await Promise.all(sends);
    const sent = results.filter(Boolean).length;

    const updates = {};
    Object.keys(bumps).forEach(uid => {
        updates[`participants/${uid}/nDate`] = bumps[uid].nDate;
        updates[`participants/${uid}/nCount`] = bumps[uid].nCount;
    });
    try { await admin.database().ref(`rooms/${roomId}`).update(updates); } catch (e) {
        console.warn('[rooms push] counter update failed:', e.message);
    }
    return sent;
}

function serializeRoom(id, r, uid) {
    const participants = r.participants || {};
    const occupants = r.occupants || {};
    return {
        id: id,
        title: r.title,
        category: r.category || 'general',
        style: r.style === 'polite' ? 'polite' : 'casual',
        pingpong: !!r.pingpong,
        channelId: r.channelId || null,
        startAt: r.startAt || null,
        createdAt: r.createdAt || 0,
        expiresAt: r.expiresAt || 0,
        participantCount: Object.keys(participants).length,
        occupantCount: Object.keys(occupants).length,
        maxPeople: ROOM_MAX_PEOPLE,
        joined: uid ? !!participants[uid] : false,
        isHost: uid ? r.createdBy === uid : false
    };
}

// 방 만들기 — startAt을 안 주면 "지금 바로" 방
app.post('/rooms/create', express.json(), async (req, res) => {
    if (!admin.apps.length) return res.status(503).json({ error: 'Firebase Admin not initialized' });
    const { idToken, title, category, style, pingpong, fcmToken, startAt, channelId } = req.body || {};
    if (!idToken || !title) return res.status(400).json({ error: 'idToken, title required' });

    let uid;
    try { uid = (await admin.auth().verifyIdToken(idToken)).uid; }
    catch (e) { return res.status(401).json({ error: 'Invalid token' }); }

    // 너무 먼 미래로 잡으면 노쇼가 급증하므로 24시간 이내로 제한
    let start = null;
    if (startAt) {
        const t = Number(startAt);
        if (!Number.isFinite(t)) return res.status(400).json({ error: 'startAt must be a timestamp' });
        if (t > Date.now() + ROOM_SCHEDULE_MAX_MS) return res.status(400).json({ error: 'startAt too far' });
        start = t;
    }

    try {
        const now = Date.now();
        const roomId = 'r' + now.toString(36) + Math.random().toString(36).slice(2, 8);
        await admin.database().ref(`rooms/${roomId}`).set({
            title: String(title).slice(0, 200),
            category: String(category || 'general').slice(0, 32),
            style: style === 'polite' ? 'polite' : 'casual',
            pingpong: !!pingpong,
            // "지금" 방의 실제 Agora 채널 ID. 저장해두면, 나중에 다 나가서 activeTopics(실시간
            // 접속 현황)에서 사라져도 이 값으로 정확히 같은 채널에 재입장할 수 있다 — 없으면
            // 주제를 재정규화해서 다른 채널로 새고 서로 연결이 안 될 위험이 있음.
            channelId: channelId ? String(channelId).slice(0, 200) : null,
            createdAt: now,
            createdBy: uid,
            startAt: start,
            // "지금" 방은 만든 지 24시간, "지정" 방은 약속 시각 + 2시간에 정리한다.
            // 지정 방에 만든 지 24시간을 쓰면 약속 전에 방이 사라지는 사고가 난다.
            expiresAt: start ? start + ROOM_AFTER_START_TTL_MS : now + ROOM_LIVE_TTL_MS,
            participants: { [uid]: { fcmToken: fcmToken || null, joinedAt: now, nCount: 0, nDate: kstDayKey(now) } }
        });
        res.json({ success: true, roomId });
    } catch (e) {
        console.error('[rooms/create] error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// 참여(= 알림 받기 등록). 마지막 한 자리를 두 명이 동시에 잡는 걸 막으려 트랜잭션을 건다.
app.post('/rooms/join', express.json(), async (req, res) => {
    if (!admin.apps.length) return res.status(503).json({ error: 'Firebase Admin not initialized' });
    const { idToken, roomId, fcmToken } = req.body || {};
    if (!idToken || !roomId) return res.status(400).json({ error: 'idToken, roomId required' });

    let uid;
    try { uid = (await admin.auth().verifyIdToken(idToken)).uid; }
    catch (e) { return res.status(401).json({ error: 'Invalid token' }); }

    try {
        const roomRef = admin.database().ref(`rooms/${roomId}`);
        const snap = await roomRef.once('value');
        const room = snap.val();
        if (!room) return res.json({ success: false, error: 'room_not_found' });

        const now = Date.now();
        let outcome = 'joined';
        await roomRef.child('participants').transaction(cur => {
            const ps = cur || {};
            if (ps[uid]) { outcome = 'already'; return ps; }
            if (Object.keys(ps).length >= ROOM_MAX_PEOPLE) { outcome = 'full'; return ps; }
            outcome = 'joined';
            ps[uid] = { fcmToken: fcmToken || null, joinedAt: now, nCount: 0, nDate: kstDayKey(now) };
            return ps;
        });

        if (outcome === 'full') return res.json({ success: false, full: true });

        // 시간 지정 방에서 사람이 모이는 게 보여야 기대가 생기고 노쇼가 줄어든다.
        // "지금" 방은 입장 시점(/rooms/entered)에만 알리므로 여기서는 보내지 않는다.
        if (outcome === 'joined' && room.startAt) {
            const fresh = (await roomRef.once('value')).val() || {};
            const others = Object.keys(fresh.participants || {}).filter(u => u !== uid);
            const n = Object.keys(fresh.participants || {}).length;
            if (others.length) {
                await pushToParticipants(roomId, fresh, others,
                    n >= ROOM_MAX_PEOPLE ? '🎉 자리가 다 찼어요' : '👋 새로운 참여자',
                    n >= ROOM_MAX_PEOPLE
                        ? `"${fresh.title}" — ${n}명이 다 모였어요`
                        : `"${fresh.title}" — ${n}명이 되었어요`);
            }
        }

        res.json({ success: true, already: outcome === 'already' });
    } catch (e) {
        console.error('[rooms/join] error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// 참여 취소. 아무도 안 남으면 빈 방이 목록에 남지 않게 방째로 지운다.
app.post('/rooms/leave', express.json(), async (req, res) => {
    if (!admin.apps.length) return res.status(503).json({ error: 'Firebase Admin not initialized' });
    const { idToken, roomId } = req.body || {};
    if (!idToken || !roomId) return res.status(400).json({ error: 'idToken, roomId required' });

    let uid;
    try { uid = (await admin.auth().verifyIdToken(idToken)).uid; }
    catch (e) { return res.status(401).json({ error: 'Invalid token' }); }

    try {
        const roomRef = admin.database().ref(`rooms/${roomId}`);
        await roomRef.child(`participants/${uid}`).remove();
        const left = await roomRef.child('participants').once('value');
        if (!left.exists() || left.numChildren() === 0) await roomRef.remove();
        res.json({ success: true });
    } catch (e) {
        console.error('[rooms/leave] error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// 실제 음성방에 들어갔을 때 클라이언트가 알려줌.
// 빈 방에 첫 사람이 들어온 경우에만 알림을 보낸다 — 대화 중인 방에 한 명 더 들어올 때마다
// 전원에게 푸시가 나가면 사람들이 알림을 꺼버려서 기능 자체가 죽는다.
app.post('/rooms/entered', express.json(), async (req, res) => {
    if (!admin.apps.length) return res.status(503).json({ error: 'Firebase Admin not initialized' });
    const { idToken, roomId } = req.body || {};
    if (!idToken || !roomId) return res.status(400).json({ error: 'idToken, roomId required' });

    let uid;
    try { uid = (await admin.auth().verifyIdToken(idToken)).uid; }
    catch (e) { return res.status(401).json({ error: 'Invalid token' }); }

    try {
        const roomRef = admin.database().ref(`rooms/${roomId}`);
        const room = (await roomRef.once('value')).val();
        if (!room) return res.json({ success: false, error: 'room_not_found' });

        // occupants는 클라이언트가 onDisconnect로 직접 정리한다(접속이 끊기면 자동으로 빠짐).
        const occupants = Object.keys(room.occupants || {});
        const alone = occupants.length <= 1 && (occupants.length === 0 || occupants[0] === uid);
        if (!alone) return res.json({ success: true, notified: 0, reason: 'not_empty' });

        const targets = Object.keys(room.participants || {}).filter(u => u !== uid);
        if (!targets.length) return res.json({ success: true, notified: 0, reason: 'no_targets' });

        const sent = await pushToParticipants(roomId, room, targets,
            '🔔 대화가 열렸어요',
            `"${room.title}" 방에 누가 들어왔어요`);
        res.json({ success: true, notified: sent });
    } catch (e) {
        console.error('[rooms/entered] error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// 살아있는 방 목록. 만료된 방은 응답에서 빼고 정리도 같이 해둔다.
app.post('/rooms/list', express.json(), async (req, res) => {
    if (!admin.apps.length) return res.json({ rooms: [] });
    const { idToken } = req.body || {};
    let uid = null;
    if (idToken) {
        try { uid = (await admin.auth().verifyIdToken(idToken)).uid; } catch (e) { uid = null; }
    }
    try {
        const snap = await admin.database().ref('rooms').once('value');
        const data = snap.val() || {};
        const now = Date.now();
        const rooms = [];
        const dead = [];
        Object.entries(data).forEach(([id, r]) => {
            if (!r || !r.title) return;
            if (r.expiresAt && r.expiresAt < now) { dead.push(id); return; }
            rooms.push(serializeRoom(id, r, uid));
        });
        // 대화 중 → 곧 시작 → 최신순
        rooms.sort((a, b) => {
            if (a.occupantCount !== b.occupantCount) return b.occupantCount - a.occupantCount;
            if (a.startAt && b.startAt) return a.startAt - b.startAt;
            if (a.startAt) return 1;
            if (b.startAt) return -1;
            return b.createdAt - a.createdAt;
        });
        dead.forEach(id => admin.database().ref(`rooms/${id}`).remove().catch(() => {}));
        res.json({ rooms });
    } catch (e) {
        console.error('[rooms/list] error:', e.message);
        res.json({ rooms: [] });
    }
});

// 시간 지정 방의 5분 전 / 시작 시각 알림 + 만료된 방 정리.
// 1분마다 돌면서, 이미 보낸 알림은 sent5m / sentStart 플래그로 중복 발송을 막는다.
setInterval(async () => {
    if (!admin.apps.length) return;
    try {
        const db = admin.database();
        const snap = await db.ref('rooms').once('value');
        const data = snap.val() || {};
        const now = Date.now();

        for (const [id, r] of Object.entries(data)) {
            if (!r || !r.title) continue;

            if (r.expiresAt && r.expiresAt < now) {
                await db.ref(`rooms/${id}`).remove().catch(() => {});
                continue;
            }
            if (!r.startAt) continue;

            const all = Object.keys(r.participants || {});
            if (!all.length) continue;

            const untilStart = r.startAt - now;
            if (!r.sent5m && untilStart <= 5 * 60 * 1000 && untilStart > 0) {
                await db.ref(`rooms/${id}/sent5m`).set(true);
                await pushToParticipants(id, r, all, '⏰ 곧 시작해요', `"${r.title}" — 5분 뒤에 시작해요`);
            } else if (!r.sentStart && untilStart <= 0 && untilStart > -10 * 60 * 1000) {
                await db.ref(`rooms/${id}/sentStart`).set(true);
                await pushToParticipants(id, r, all, '🎙 지금 시작해요', `"${r.title}" — 지금 들어오세요`);
            }
        }
    } catch (e) {
        console.error('[rooms scheduler] error:', e.message);
    }
}, 60 * 1000);

// 관리자 패널 전용 — 일반 유저용 /scheduled-rooms-today와 달리 누가 방을 만들었는지(createdBy)와
// 참여예약한 사람들의 uid 목록(seats)까지 그대로 내려줌. 다른 유저의 uid가 노출되면 안 되므로
// 반드시 관리자 인증을 거친 뒤에만 응답함
app.post('/admin/scheduled-rooms-today', async (req, res) => {
    if (!admin.apps.length) return res.json({ rooms: [] });
    const { idToken } = req.body || {};
    let decoded;
    try {
        decoded = await admin.auth().verifyIdToken(idToken);
    } catch (e) {
        return res.status(401).json({ error: 'Invalid token' });
    }
    if (!ADMIN_UIDS.has(decoded.uid) && !ADMIN_EMAILS.has(decoded.email)) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    try {
        const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
        const today = kst.toISOString().slice(0, 10);
        const snap = await admin.database().ref(`scheduledRooms/${today}`).once('value');
        const data = snap.val() || {};
        const rooms = Object.entries(data).map(([id, r]) => {
            const seats = r.seats || {};
            const seatEntries = Object.entries(seats).map(([uid, s]) => ({ uid, joinedAt: s.joinedAt || 0 }));
            seatEntries.sort((a, b) => a.joinedAt - b.joinedAt);
            // 예전 방(생성 당시 createdBy가 없던 방)은 가장 먼저 좌석을 채운 사람을 만든 사람으로 간주
            const createdBy = r.createdBy || (seatEntries[0] && seatEntries[0].uid) || null;
            return {
                id,
                title: r.title,
                category: r.category || 'general',
                style: r.style === 'polite' ? 'polite' : 'casual',
                pingpong: !!r.pingpong,
                maxPeople: 4,
                createdBy,
                seats: seatEntries
            };
        });
        res.json({ rooms });
    } catch (e) {
        console.error('[admin/scheduled-rooms-today] error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// 관리자 패널에서 오늘 예약된 방을 강제로 삭제 — 예약자 전원의 좌석 기록도 함께 지워짐
app.post('/admin/delete-scheduled-room', async (req, res) => {
    if (!admin.apps.length) return res.status(503).json({ error: 'Firebase Admin not initialized' });
    const { idToken, roomId } = req.body;
    if (!idToken || !roomId) return res.status(400).json({ error: 'idToken, roomId required' });

    let decoded;
    try {
        decoded = await admin.auth().verifyIdToken(idToken);
    } catch (e) {
        return res.status(401).json({ error: 'Invalid token' });
    }
    if (!ADMIN_UIDS.has(decoded.uid) && !ADMIN_EMAILS.has(decoded.email)) {
        return res.status(403).json({ error: 'Forbidden' });
    }

    try {
        const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
        const today = kst.toISOString().slice(0, 10);
        await admin.database().ref(`scheduledRooms/${today}/${roomId}`).remove();
        res.json({ success: true });
    } catch (e) {
        console.error('[admin/delete-scheduled-room] error:', e.message);
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

        // users/{uid} 바깥에 따로 떠 있는 대기열 흔적도 정리 (안 지우면 연결이 끊기지 않아
        // onDisconnect가 발동하지 않고, 탈퇴한 유저가 대기자 수에 영원히 잡혀 있게 됨)
        await db.ref('waiting/' + uid).remove().catch(() => {});

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
    let audioMime = 'audio/webm';

    bb.on('file', (name, file, info) => {
        audioMime = (info && info.mimeType) || 'audio/webm';
        file.on('data', chunk => chunks.push(chunk));
    });

    bb.on('field', (name, val) => { fields[name] = val; });

    bb.on('close', async () => {
        const audioBuffer = Buffer.concat(chunks);
        const { reportedUid, reporterUid, channel, reason } = fields;

        if (!reportedUid) {
            return res.status(400).json({ error: 'Missing reportedUid' });
        }

        // 같은 사람이 같은 상대를 반복 신고(신고 테러)하는 걸 막기 위해, 실제 오디오 업로드/AI 분석 전에
        // 먼저 중복 여부부터 확인함 — 이미 신고한 적 있으면 여기서 바로 끝내고 안내만 내려줌.
        // reportedBy에는 이 유저를 신고한 사람들을 모아둬서, 제재 단계 판단 시 "서로 다른 사람이
        // 몇 명이나 신고했는지"를 셀 수 있게 함(같은 사람이 여러 번 눌러도 여기선 한 번만 잡힘)
        let distinctReporterCount = null;
        if (reporterUid && admin.apps.length) {
            try {
                const db0 = admin.database();
                const pairRef = db0.ref(`reportPairs/${reporterUid}/${reportedUid}`);
                const pairSnap = await pairRef.once('value');
                if (pairSnap.exists()) {
                    return res.json({ success: false, alreadyReported: true });
                }
                await pairRef.set(Date.now());
                await db0.ref(`reportedBy/${reportedUid}/${reporterUid}`).set(Date.now());
                const reportedBySnap = await db0.ref(`reportedBy/${reportedUid}`).once('value');
                distinctReporterCount = Object.keys(reportedBySnap.val() || {}).length;
            } catch (e) { console.error('[reportUser] dedup check failed:', e.message); }
        }

        const hasAudio = audioBuffer.length > 0;
        let audioStorageUrl = null;
        let aiResult = null;

        // 1. Storage 저장 (실패해도 계속)
        if (hasAudio && storageBucket) {
            try {
                const ext = audioMime.includes('mp4') ? 'mp4' : 'webm';
                const storagePath = `reports/${reportedUid}/${Date.now()}.${ext}`;
                const file = storageBucket.file(storagePath);
                await file.save(audioBuffer, { metadata: { contentType: audioMime } });
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

            // 4. 서로 다른 사람이 신고한 횟수 기준으로 자동 제재 (경고 → 24시간 정지 → 영구 정지)
            // AI 유해성 판정과 무관하게 진행 — 애매한 판정이라도 여러 명이 신고하면 우선 제재하고,
            // 억울한 경우는 이의신청 들어오면 관리자가 검토해서 해제하는 방식(이의신청 전용 안전장치)
            if (distinctReporterCount !== null) {
                const userRef = db.ref('users/' + reportedUid);
                const now = Date.now();
                const escalationReason = reason || (aiResult ? aiResult.reason : null) || '반복 신고 누적';

                if (distinctReporterCount === 1) {
                    await userRef.update({ reportCount: distinctReporterCount, warnedAt: now, lastReportReason: escalationReason });
                } else if (distinctReporterCount === 2) {
                    await userRef.update({ reportCount: distinctReporterCount, suspendedUntil: now + 86400000, suspendReason: escalationReason, lastReportReason: escalationReason });
                } else if (distinctReporterCount >= 3) {
                    await userRef.update({ reportCount: distinctReporterCount, banned: true, bannedAt: now, banReason: escalationReason });
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

// 누군가(게스트 포함) 로그인하면 운영자 기기로 푸시 알림 — meta/adminFcmTokens에 등록된 모든 기기로 전송
// (폰, 컴퓨터 등 여러 기기를 동시에 등록해둘 수 있음. meta/adminFcmToken은 예전 방식의 잔여 데이터로,
//  있으면 같이 보내고 없으면 무시함)
app.post('/notify-admin-login', async (req, res) => {
    if (!admin.apps.length) return res.json({ notified: false });
    // 진단용: 이 요청이 서버까지 실제로 도달해서 어떻게 처리됐는지 DB에 남겨둠 (설정 화면의 "마지막 알림 로그 보기"에서 확인 가능)
    const writeDebug = (extra) => admin.database().ref('meta/lastLoginNotifyDebug').set({ at: Date.now(), ...extra }).catch(() => {});
    try {
        const { isGuest, email } = req.body;
        const [tokensSnap, legacySnap] = await Promise.all([
            admin.database().ref('meta/adminFcmTokens').once('value'),
            admin.database().ref('meta/adminFcmToken').once('value')
        ]);
        const tokenMap = tokensSnap.val() || {};
        const targets = Object.entries(tokenMap)
            .filter(([, v]) => v && v.token)
            .map(([key, v]) => ({ key, token: v.token, legacy: false }));
        const legacyToken = legacySnap.val();
        if (legacyToken) targets.push({ key: null, token: legacyToken, legacy: true });

        if (targets.length === 0) {
            await writeDebug({ targetCount: 0, notifiedCount: 0, errors: ['등록된 기기 없음 (meta/adminFcmTokens 비어있음)'] });
            return res.json({ notified: false });
        }

        const notification = {
            title: '새 로그인 알림 🔔',
            body: isGuest ? '게스트가 접속했어요' : `${email || '회원'}님이 로그인했어요`
        };

        let notifiedCount = 0;
        const errors = [];
        await Promise.all(targets.map(async (t) => {
            try {
                await admin.messaging().send({ token: t.token, notification });
                notifiedCount++;
            } catch (sendErr) {
                errors.push(`${t.token.slice(0, 10)}...: ${sendErr.code || sendErr.message}`);
                // 토큰이 만료/무효화된 경우 — DB에서 지워서 다음에 해당 기기가 앱을 열 때 새 토큰으로 자동 재등록되게 함
                if (sendErr.code === 'messaging/registration-token-not-registered' || sendErr.code === 'messaging/invalid-registration-token') {
                    if (t.legacy) await admin.database().ref('meta/adminFcmToken').remove().catch(() => {});
                    else await admin.database().ref('meta/adminFcmTokens/' + t.key).remove().catch(() => {});
                } else {
                    console.error('[notify-admin-login] send error:', sendErr.message);
                }
            }
        }));
        await writeDebug({ targetCount: targets.length, notifiedCount, errors });
        res.json({ notified: notifiedCount > 0, count: notifiedCount });
    } catch (e) {
        console.error('[notify-admin-login] error:', e.message);
        await writeDebug({ targetCount: 0, notifiedCount: 0, errors: [e.message] });
        res.json({ notified: false });
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
