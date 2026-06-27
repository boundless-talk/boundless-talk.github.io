const { GoogleGenerativeAI } = require('@google/generative-ai');
const admin = require('firebase-admin');
const Busboy = require('busboy');

if (!admin.apps.length) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: "https://b-talk-login-default-rtdb.firebaseio.com/",
        storageBucket: "b-talk-login.firebasestorage.app"
    });
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const db = admin.database();
let bucket;
try { bucket = admin.storage().bucket(); } catch(e) { console.error('[BUCKET INIT ERROR]', e.message); }

const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
};

exports.handler = async function(event, context) {
    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS_HEADERS, body: '' };
    if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS_HEADERS, body: 'Method Not Allowed' };

    return new Promise((resolve, reject) => {
        const busboy = Busboy({ headers: event.headers });
        let audioBuffer = [];
        let fields = {};

        busboy.on('file', (name, file, info) => {
            file.on('data', (data) => { audioBuffer.push(data); });
        });

        busboy.on('field', (name, value) => { fields[name] = value; });

        busboy.on('finish', async () => {
            const finalAudioBuffer = Buffer.concat(audioBuffer);
            const { reportedUid, reporterUid, channel } = fields;

            if (!reportedUid) {
                return resolve({ statusCode: 400, headers: CORS_HEADERS, body: 'Missing reportedUid' });
            }

            const hasAudio = finalAudioBuffer.length > 0;
            let audioStorageUrl = null;
            let aiResult = null;

            // 1. Storage 저장 (실패해도 계속)
            if (hasAudio && bucket) {
                try {
                    const timestamp = Date.now();
                    const storagePath = `reports/${reportedUid}/${timestamp}.webm`;
                    const file = bucket.file(storagePath);
                    await file.save(finalAudioBuffer, { metadata: { contentType: 'audio/webm' } });
                    const [signedUrl] = await file.getSignedUrl({
                        action: 'read',
                        expires: Date.now() + 7 * 24 * 60 * 60 * 1000
                    });
                    audioStorageUrl = signedUrl;
                    console.log(`[STORAGE] Saved`);
                } catch (e) { console.error('[STORAGE ERROR]', e.message); }
            }

            // 2. Gemini AI 유해성 분석 (실패해도 계속)
            if (hasAudio) {
                try {
                    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
                    const prompt = `이 음성 채팅 대화에 심한 욕설, 성희롱, 혐오 발언이 포함되어 있는지 판별하세요. JSON으로만 응답: {"isToxic": true/false, "reason": "간단한 이유"}`;
                    const result = await model.generateContent([
                        prompt,
                        { inlineData: { mimeType: 'audio/webm', data: finalAudioBuffer.toString('base64') } }
                    ]);
                    const text = result.response.text().trim();
                    const jsonMatch = text.match(/\{[\s\S]*\}/);
                    if (jsonMatch) aiResult = JSON.parse(jsonMatch[0]);
                    console.log(`[GEMINI] isToxic: ${aiResult?.isToxic}`);
                } catch (e) { console.error('[GEMINI ERROR]', e.message); }
            }

            // 3. Firebase DB 저장 (항상 실행)
            try {
                await db.ref('reports').push({
                    reporterUid: reporterUid || null,
                    reportedUid,
                    channel: channel || null,
                    isToxic: aiResult ? aiResult.isToxic : null,
                    reason: aiResult ? (aiResult.reason || null) : null,
                    audioUrl: audioStorageUrl,
                    hasAudio,
                    submittedAt: Date.now(),
                    resolved: false
                });
                console.log(`[DB] Report saved for ${reportedUid}`);
            } catch (e) {
                console.error('[DB ERROR]', e.message);
                return resolve({ statusCode: 500, headers: CORS_HEADERS, body: 'DB write failed' });
            }

            // 4. 유해성 감지 시 제재
            if (aiResult && aiResult.isToxic) {
                try {
                    const userRef = db.ref('users/' + reportedUid);
                    const snapshot = await userRef.once('value');
                    const userData = snapshot.val() || {};
                    const reportCount = (userData.reportCount || 0) + 1;
                    const now = Date.now();

                    if (reportCount === 1) {
                        await userRef.update({ reportCount, warnedAt: now, lastReportReason: aiResult.reason });
                    } else if (reportCount === 2) {
                        await userRef.update({ reportCount, suspendedUntil: now + 86400000, suspendReason: aiResult.reason, lastReportReason: aiResult.reason });
                    } else {
                        await userRef.update({ reportCount, banned: true, bannedAt: now, banReason: aiResult.reason });
                    }
                    console.log(`[SANCTION] count: ${reportCount}`);
                } catch (e) { console.error('[SANCTION ERROR]', e.message); }
            }

            resolve({
                statusCode: 200,
                headers: CORS_HEADERS,
                body: JSON.stringify({ success: true, toxic: aiResult ? aiResult.isToxic : false })
            });
        });

        busboy.write(Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8'));
        busboy.end();
    });
};
