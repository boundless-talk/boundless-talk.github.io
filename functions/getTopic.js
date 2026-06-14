const { GoogleGenAI } = require('@google/genai');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

exports.handler = async function(event, context) {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    try {
        const body = JSON.parse(event.body);
        const userInput = body.userInput || "general";

        const prompt = `
당신은 음성 채팅 앱의 주제 정규화 엔진입니다.
사용자 입력: "${userInput}"

규칙:
1. 의미가 같거나 유사한 입력은 반드시 동일한 키워드로 통일한다.
   - "사랑", "love", "연애", "좋아하는 사람", "썸" → love
   - "친구", "friend", "우정", "friendship" → friendship
   - "슬픔", "sad", "sadness", "우울", "슬프다" → sadness
   - "음식", "food", "먹방", "맛집", "뭐먹지" → food
   - "게임", "game", "gaming", "롤", "리그오브레전드" → gaming
   - "여행", "travel", "trip", "해외여행", "국내여행" → travel
   - "음악", "music", "노래", "kpop", "케이팝" → music
   - "영화", "movie", "film", "넷플릭스", "드라마" → entertainment
   - "운동", "fitness", "헬스", "exercise", "workout" → fitness
   - "취업", "job", "career", "취직", "면접", "이직" → career
2. 위 예시에 없는 주제도 같은 원칙으로 가장 보편적이고 대표적인 영문 단어로 수렴시킨다.
3. 출력 조건: 소문자 영문/숫자/하이픈만 사용, 공백 없음, 최대 20자.
4. 키워드 1개만 출력. 설명, 따옴표, 부가 텍스트 절대 금지.
`;

        const response = await ai.models.generateContent({
            model: 'gemini-2.0-flash-lite',
            contents: prompt,
        });

        const raw = response.text();
        const topic = raw.trim().toLowerCase().replace(/[^a-z0-9-]/g, "");

        return {
            statusCode: 200,
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
            body: JSON.stringify({ topic: topic || "general" })
        };
    } catch (error) {
        console.error("AI Topic Error:", error);
        return {
            statusCode: 500,
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
            body: JSON.stringify({ error: 'Failed to generate topic', topic: "general" })
        };
    }
};