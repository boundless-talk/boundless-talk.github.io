const { GoogleGenAI } = require('@google/genai');
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

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const db = admin.database();
const bucket = admin.storage().bucket();

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

            // 1. Storage 저장 + Gemini 분석 (실패해도 신고 내역은 저장)
            if (hasAudio) {
                try {
                    const timestamp = Date.now();
                    const storagePath = `reports/${reportedUid}/${timestamp}.webm`;
                    const file = bucket.file(storagePath);

                    await file.save(finalAudioBuffer, {
                        metadata: { contentType: 'audio/webm' }
                    });

                    const [signedUrl] = await file.getSignedUrl({
                        action: 'read',
                        expires: Date.now() + 7 * 24 * 60 * 60 * 1000
                    });
                    audioStorageUrl = signedUrl;
                    console.log(`[STORAGE] Saved: ${storagePath}`);
                } catch (storageErr) {
                    console.error('[STORAGE ERROR]', storageErr.message);
                }

                try {
                    const prompt = `
                    첨부된 오디오 파일은 익명 음성 채팅방의 대화 내용입니다.
                    이 음성 내용 중에 심한 욕설, 성희롱, 차별적 혐오 발언, 또는 심각한 범죄 모의 내용이 포함되어 있는지 판별하세요.
                    결과를 JSON 형식으로만 반환하세요: {"isToxic": true/false, "reason": "간단한 이유"}
                    `;

                    const base64Audio = finalAudioBuffer.toString('base64');
                    const response = await ai.models.generateContent({
                        model: 'gemini-2.5-flash',
                        contents: [{
                            parts: [
                                { text: prompt },
                                { inlineData: { mimeType: 'audio/webm', data: base64Audio } }
                            ]
                        }],
                        config: { responseMimeType: "application/json" }
                    });
                    aiResult = JSON.parse(response.text);
                    console.log(`[GEMINI] isToxic: ${aiResult.isToxic}, reason: ${aiResult.reason}`);
                } catch (geminiErr) {
                    console.error('[GEMINI ERROR]', geminiErr.message);
                }
            }

            // 2. 신고 내역 Firebase DB 저장 (항상 실행)
            try {
                const reportEntry = {
                    reporterUid: reporterUid || null,
                    reportedUid: reportedUid,
                    channel: channel || null,
                    isToxic: aiResult ? aiResult.isToxic : null,
                    reason: aiResult ? (aiResult.reason || null) : null,
                    audioUrl: audioStorageUrl,
                    hasAudio: hasAudio,
                    submittedAt: Date.now(),
                    resolved: false
                };

                await db.ref('reports').push(reportEntry);
                console.log(`[DB] Report saved for ${reportedUid}`);
            } catch (dbErr) {
                console.error('[DB ERROR]', dbErr.message);
                return resolve({ statusCode: 500, headers: CORS_HEADERS, body: 'DB write failed' });
            }

            // 3. 음성 없이 신고한 경우
            if (!hasAudio) {
                try {
                    const falseReportRef = db.ref('users/' + (reporterUid || 'unknown') + '/falseReportCount');
                    const snap = await falseReportRef.once('value');
                    await falseReportRef.set((snap.val() || 0) + 1);
                } catch(e) {}
                return resolve({
                    statusCode: 200,
                    headers: CORS_HEADERS,
                    body: JSON.stringify({ success: true, toxic: false, note: 'no_audio' })
                });
            }

            // 4. 유해성 감지 시 3단계 제재
            if (aiResult && aiResult.isToxic) {
                try {
                    const userRef = db.ref('users/' + reportedUid);
                    const snapshot = await userRef.once('value');
                    const userData = snapshot.val() || {};
                    const reportCount = (userData.reportCount || 0) + 1;
                    const now = Date.now();

                    if (reportCount === 1) {
                        await userRef.update({ reportCount, warnedAt: now, lastReportReason: aiResult.reason });
                        console.log(`[WARN] ${reportedUid}`);
                    } else if (reportCount === 2) {
                        await userRef.update({ reportCount, suspendedUntil: now + 24 * 60 * 60 * 1000, suspendReason: aiResult.reason, lastReportReason: aiResult.reason });
                        console.log(`[SUSPEND 24H] ${reportedUid}`);
                    } else {
                        await userRef.update({ reportCount, banned: true, bannedAt: now, banReason: aiResult.reason });
                        console.log(`[BAN PERMANENT] ${reportedUid}`);
                    }
                } catch (sanctionErr) {
                    console.error('[SANCTION ERROR]', sanctionErr.message);
                }
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
