const { GoogleGenerativeAI } = require('@google/generative-ai');
const Busboy = require('busboy');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

exports.handler = async (event, context) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS_HEADERS, body: 'Method Not Allowed' };

  return new Promise((resolve, reject) => {
    const headers = event.headers['content-type'] ? event.headers : { 'content-type': event.headers['Content-Type'] };
    const busboy = Busboy({ headers });

    let audioBuffer = null;
    let mimeType = 'audio/webm';
    let currentLang = 'ko';

    busboy.on('file', (fieldname, file, info) => {
      mimeType = info.mimeType || 'audio/webm';
      const chunks = [];
      file.on('data', (data) => chunks.push(data));
      file.on('end', () => { audioBuffer = Buffer.concat(chunks); });
    });

    busboy.on('field', (fieldname, val) => {
      if (fieldname === 'lang') currentLang = val;
    });

    busboy.on('finish', async () => {
      try {
        if (!audioBuffer || audioBuffer.length === 0) {
          return resolve({ statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ summary: '' }) });
        }

        const prompt = currentLang === 'ko'
            ? "이 음성 대화를 듣고 주요 내용을 3문장 이내로 요약해 주세요. 대화가 아니라면 '소음만 감지되었습니다'라고 응답해 주세요."
            : "Listen to this conversation and summarize the main points in under 3 sentences. If there is no speech, reply with 'Only noise detected.'";

        const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
        const result = await model.generateContent([
          prompt,
          { inlineData: { data: audioBuffer.toString('base64'), mimeType } }
        ]);

        resolve({
          statusCode: 200,
          headers: CORS_HEADERS,
          body: JSON.stringify({ summary: result.response.text() })
        });
      } catch (error) {
        console.error("Gemini API Error:", error);
        resolve({
          statusCode: 500,
          headers: CORS_HEADERS,
          body: JSON.stringify({ error: "AI 요약 생성 중 오류가 발생했습니다." })
        });
      }
    });

    busboy.end(event.isBase64Encoded ? Buffer.from(event.body, 'base64') : event.body);
  });
};
