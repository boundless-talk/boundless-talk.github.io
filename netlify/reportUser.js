const { GoogleGenAI } = require('@google/genai');
const admin = require('firebase-admin');
const Busboy = require('busboy');

// Firebase Admin 초기화 (서버당 1번만)
if (!admin.apps.length) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: "https://b-talk-login-default-rtdb.firebaseio.com/"
    });
}

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const db = admin.database();

exports.handler = async function(event, context) {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

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
                const { reportedUid } = fields;

                if (!reportedUid || finalAudioBuffer.length === 0) {
                    return resolve({ statusCode: 400, body: 'Missing audio or UID' });
                }

                // 1. Gemini AI 유해성 검사
                const prompt = `
                첨부된 오디오 파일은 익명 음성 채팅방의 대화 내용 1분입니다.
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


                    const result = JSON.parse(response.text);

               // 2. 신고 내역 Firebase에 저장 (관리자 패널용)
                await db.ref('reports').push({
                reporterUid: fields.reporterUid || null,
                reportedUid: reportedUid,
                channel: fields.channel || null,
                isToxic: result.isToxic,
                reason: result.reason || null,
                submittedAt: Date.now(),
                resolved: false
            });

                // 3. 유해성 감지 시 3단계 제재 처리
                 if (result.isToxic) { userRef = db.ref('users/' + reportedUid);
                    const snapshot = await userRef.once('value');
                    const userData = snapshot.val() || {};

                    const reportCount = (userData.reportCount || 0) + 1;
                    const now = Date.now();

                    console.log(`[REPORT] User: ${reportedUid}, Count: ${reportCount}, Reason: ${result.reason}`);

                    if (reportCount === 1) {
                        // 1단계: 경고
                        await userRef.update({
                            reportCount,
                            warnedAt: now,
                            lastReportReason: result.reason
                        });
                        console.log(`[WARN] User: ${reportedUid}`);

                    } else if (reportCount === 2) {
                        // 2단계: 24시간 정지
                        await userRef.update({
                            reportCount,
                            suspendedUntil: now + 24 * 60 * 60 * 1000, // 24시간 후
                            suspendReason: result.reason,
                            lastReportReason: result.reason
                        });
                        console.log(`[SUSPEND 24H] User: ${reportedUid}`);

                    } else {
                        // 3단계: 영구정지 (3회 이상)
                        await userRef.update({
                            reportCount,
                            banned: true,
                            bannedAt: now,
                            banReason: result.reason
                        });
                        console.log(`[BAN PERMANENT] User: ${reportedUid}`);
                    }
                }

                resolve({
                    statusCode: 200,
                    body: JSON.stringify({ success: true, toxic: result.isToxic })
                });

            } catch (error) {
                console.error("Report process failed:", error);
                resolve({ statusCode: 500, body: 'Internal Server Error' });
            }
        });

        busboy.write(Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8'));
        busboy.end();
    });
};