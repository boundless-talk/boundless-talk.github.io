const { GoogleGenAI } = require('@google/genai');
const Busboy = require('busboy');

// 환경 변수에서 Gemini API 키 로드
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

exports.handler = async (event, context) => {
  // POST 요청만 허용
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  return new Promise((resolve, reject) => {
    // 주의: Netlify 함수에서는 헤더의 대소문자가 다를 수 있음
    const headers = event.headers['content-type'] ? event.headers : { 'content-type': event.headers['Content-Type'] };
    const busboy = Busboy({ headers });
    
    let audioBuffer = null;
    let mimeType = 'audio/webm'; 
    let currentLang = 'ko'; // 기본 언어

    // 1. 폼 데이터에서 오디오 파일과 언어 설정 추출
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
        if (!audioBuffer) {
          throw new Error('오디오 파일이 전달되지 않았습니다.');
        }

        // 2. Gemini에게 내릴 프롬프트 작성 (언어별 분기)
        const prompt = currentLang === 'ko'
            ? "이 음성 대화를 듣고 주요 내용을 3문장 이내로 요약해 주세요. 대화가 아니라면 '소음만 감지되었습니다'라고 응답해 주세요."
            : "Listen to this conversation and summarize the main points in under 3 sentences. If there is no speech, reply with 'Only noise detected.'";

        // 3. Gemini 1.5 Flash에 오디오 버퍼를 Base64 인라인 데이터로 전송 (STT + 요약 동시 처리)
        const response = await ai.models.generateContent({
          model: 'gemini-1.5-flash',
          contents: [
            prompt,
            {
              inlineData: {
                data: audioBuffer.toString('base64'),
                mimeType: mimeType
              }
            }
          ]
        });

        // 4. 결과 반환
        resolve({
          statusCode: 200,
          body: JSON.stringify({ summary: response.text })
        });
      } catch (error) {
        console.error("Gemini API Error:", error);
        resolve({
          statusCode: 500,
          body: JSON.stringify({ error: "AI 요약 생성 중 오류가 발생했습니다." })
        });
      }
    });

    // Netlify API Gateway는 바이너리 데이터를 Base64로 인코딩해서 보낼 수 있음
    busboy.end(event.isBase64Encoded ? Buffer.from(event.body, 'base64') : event.body);
  });
};