const { GoogleGenAI } = require('@google/genai');

// 환경변수에서 API 키 로드
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

exports.handler = async function(event, context) {
    // POST 요청만 허용
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    try {
        const body = JSON.parse(event.body);
        const userInput = body.userInput || "general";

        // AI에게 지시할 프롬프트
        const prompt = `
        사용자가 음성 채팅방 주제로 다음 텍스트를 입력했습니다: "${userInput}"
        이 주제를 분석하여 가장 핵심이 되는 영문 키워드 1~2개로 압축해줘.
        조건: 소문자, 알파벳, 숫자, 하이픈(-)만 사용. 공백 금지. 최대 20자.
        예시: "테슬라 주식 이야기" -> "tesla-stock"
        예시: "오늘 저녁 뭐먹지" -> "dinner-food"
        결과값만 딱 출력해.
        `;

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: prompt,
        });

        const topic = response.text.trim().toLowerCase().replace(/[^a-z0-9-]/g, "");

        return {
            statusCode: 200,
            body: JSON.stringify({ topic: topic || "general" })
        };
    } catch (error) {
        console.error("AI Topic Error:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to generate topic', topic: "general" })
        };
    }
};