const { GoogleGenAI } = require('@google/genai');
const admin = require('firebase-admin');
const Busboy = require('busboy');

if (!admin.apps.length) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: "https://b-talk-login-default-rtdb.firebaseio.com/",
        storageBucket: "b-talk-login.appspot.com"
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
            try {
                const finalAudioBuffer = Buffer.concat(audioBuffer);
                const { reportedUid, reporterUid, channel } = fields;

                if (!reportedUid) {
                    return resolve({ statusCode: 400, headers: CORS_HEADERS, body: 'Missing reportedUid' });
                }

                const hasAudio = finalAudioBuffer.length > 0;
                let audioStorageUrl = null;
                let aiResult = null;

                // 1. 음성 파일이 있으면 Storage에 저장 + Gemini 분석
                if (hasAudio) {
                    // Firebase Storage에 원본 음성 파일 저장
                    const timestamp = Date.now();
                    const storagePath = `reports/${reportedUid}/${timestamp}.webm`;
                    const file = bucket.file(storagePath);

                    await file.save(finalAudioBuffer, {
                        metadata: { contentType: 'audio/webm' }
                    });

                    // 다운로드 가능한 서명된 URL 생성 (7일 유효)
                    const [signedUrl] = await file.getSignedUrl({
                        action: 'read',
                        expires: Date.now() + 7 * 24 * 60 * 60 * 1000
                    });
                    audioStorageUrl = signedUrl;

                    // Gemini AI 유해성 검사
                    const prompt = `
                    첨부된 오디오 파일은 익명 음성 채팅방의 대화 내용입니다.
                    이 음성 내용 중에 심한 욕설, 성희롱, 차별적 혐오 발언, 또는 심각한 범죄 모의 내용이 포함되어 있는지 판별하세요.
                    결과를 JSON 형식으로만 반환하세요: {"isToxic": true/false, "reason": "간단한 이유"}
                    `;

                    const base64Audio = finalAudioBuffer.toString('base64');
                    const response = await ai.models.generateContent({
                        model: 'gemini-2.5-flash',
                        contents: [
                            { text: prompt },
                            { inlineData: { mimeType: 'audio/webm', data: base64Audio } }
                        ],
                        config: { responseMimeType: "application/json" }
                    });

                    aiResult = JSON.parse(response.text);
                }

                // 2. 신고 내역 Firebase에 저장 (음성 URL 포함)
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

                // 3. 음성 없이 신고한 경우 — 허위 신고 가능성 기록
                if (!hasAudio) {
                    const falseReportRef = db.ref('users/' + (reporterUid || 'unknown') + '/falseReportCount');
                    const snap = await falseReportRef.once('value');
                    await falseReportRef.set((snap.val() || 0) + 1);
                    console.log(`[NO_AUDIO_REPORT] reporter: ${reporterUid}, reported: ${reportedUid}`);
                    return resolve({
                        statusCode: 200,
                        headers: CORS_HEADERS,
                        body: JSON.stringify({ success: true, toxic: false, note: 'no_audio' })
                    });
                }

                // 4. 유해성 감지 시 3단계 제재 처리
                if (aiResult && aiResult.isToxic) {
                    const userRef = db.ref('users/' + reportedUid);
                    const snapshot = await userRef.once('value');
                    const userData = snapshot.val() || {};

                    const reportCount = (userData.reportCount || 0) + 1;
                    const now = Date.now();

                    console.log(`[REPORT] User: ${reportedUid}, Count: ${reportCount}, Reason: ${aiResult.reason}`);

                    if (reportCount === 1) {
                        await userRef.update({
                            reportCount,
                            warnedAt: now,
                            lastReportReason: aiResult.reason
                        });
                        console.log(`[WARN] User: ${reportedUid}`);

                    } else if (reportCount === 2) {
                        await userRef.update({
                            reportCount,
                            suspendedUntil: now + 24 * 60 * 60 * 1000,
                            suspendReason: aiResult.reason,
                            lastReportReason: aiResult.reason
                        });
                        console.log(`[SUSPEND 24H] User: ${reportedUid}`);

                    } else {
                        await userRef.update({
                            reportCount,
                            banned: true,
                            bannedAt: now,
                            banReason: aiResult.reason
                        });
                        console.log(`[BAN PERMANENT] User: ${reportedUid}`);
                    }
                }

                resolve({
                    statusCode: 200,
                    headers: CORS_HEADERS,
                    body: JSON.stringify({ success: true, toxic: aiResult ? aiResult.isToxic : false })
                });

            } catch (error) {
                console.error("Report process failed:", error);
                resolve({ statusCode: 500, headers: CORS_HEADERS, body: 'Internal Server Error' });
            }
        });

        busboy.write(Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8'));
        busboy.end();
    });
};
