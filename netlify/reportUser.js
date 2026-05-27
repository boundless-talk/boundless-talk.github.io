const { GoogleGenAI } = require('@google/genai');
const admin = require('firebase-admin');
const Busboy = require('busboy');

// Firebase Admin 초기화 (서버당 1번만)
if (!admin.apps.length) {
    // Netlify 환경변수에 저장해둔 Firebase 서비스 어카운트 JSON을 불러옵니다.
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: "https://b-talk-login-default-rtdb.firebaseio.com/" // 본인의 DB URL
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
            file.on('data', (data) => {
                audioBuffer.push(data);
            });
        });

        busboy.on('field', (name, value) => {
            fields[name] = value;
        });

        busboy.on('finish', async () => {
            try {
                const finalAudioBuffer = Buffer.concat(audioBuffer);
                const { reportedUid } = fields;

                if (!reportedUid || finalAudioBuffer.length === 0) {
                    return resolve({ statusCode: 400, body: 'Missing audio or UID' });
                }

                // 1. Gemini AI로 오디오 파일 전송 및 유해성 검사
                const prompt = `
                첨부된 오디오 파일은 익명 음성 채팅방의 대화 내용 1분입니다.
                이 음성 내용 중에 심한 욕설, 성희롱, 차별적 혐오 발언, 또는 심각한 범죄 모의 내용이 포함되어 있는지 판별하세요.
                결과를 JSON 형식으로만 반환하세요: {"isToxic": true/false, "reason": "간단한 이유"}
                `;

                // Base64로 변환하여 모델에 전달
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

                // 2. 유해성이 감지되면 Firebase DB에 banned: true 기록
                if (result.isToxic) {
                    console.log(`[BAN EXECUTED] User: ${reportedUid}, Reason: ${result.reason}`);
                    await db.ref('users/' + reportedUid).update({ banned: true });
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

        // Netlify Functions의 body는 base64로 인코딩되어 들어오므로 디코딩하여 busboy에 주입
        busboy.write(Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8'));
        busboy.end();
    });
};