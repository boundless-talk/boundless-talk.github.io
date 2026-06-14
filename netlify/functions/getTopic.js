const { GoogleGenAI } = require('@google/genai');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// 매핑 테이블 (API 한도 초과 시 폴백)
const TOPIC_MAP = {
    // 감정
    "슬픔": "sadness", "sad": "sadness", "sadness": "sadness", "우울": "sadness", "슬프다": "sadness",
    "행복": "happiness", "happy": "happiness", "happiness": "happiness", "기쁨": "happiness",
    "화남": "anger", "angry": "anger", "anger": "anger", "분노": "anger",
    "외로움": "loneliness", "lonely": "loneliness", "외롭다": "loneliness",
    "불안": "anxiety", "anxiety": "anxiety", "걱정": "anxiety",
    // 관계
    "사랑": "love", "love": "love", "연애": "love", "썸": "love", "좋아하는사람": "love",
    "친구": "friendship", "friend": "friendship", "우정": "friendship", "friendship": "friendship",
    "가족": "family", "family": "family",
    // 일상
    "음식": "food", "food": "food", "먹방": "food", "맛집": "food", "요리": "food",
    "여행": "travel", "travel": "travel", "trip": "travel", "해외여행": "travel", "국내여행": "travel",
    "음악": "music", "music": "music", "노래": "music", "kpop": "music", "케이팝": "music",
    "영화": "entertainment", "movie": "entertainment", "film": "entertainment", "드라마": "entertainment", "넷플릭스": "entertainment",
    "운동": "fitness", "fitness": "fitness", "헬스": "fitness", "exercise": "fitness", "workout": "fitness",
    "게임": "gaming", "game": "gaming", "gaming": "gaming", "롤": "gaming", "리그오브레전드": "gaming",
    "여행": "travel",
    // 직업/미래
    "취업": "career", "job": "career", "career": "career", "취직": "career", "면접": "career", "이직": "career",
    "공부": "study", "study": "study", "학교": "study", "수능": "study", "시험": "study",
    "돈": "money", "money": "money", "재테크": "money", "투자": "money", "주식": "money",
    // 기술
    "테슬라": "tesla", "tesla": "tesla", "전기차": "tesla", "ev": "tesla",
    "ai": "ai", "인공지능": "ai", "chatgpt": "ai",
    "코딩": "coding", "coding": "coding", "프로그래밍": "coding", "개발": "coding",
    // 기타
    "스포츠": "sports", "sports": "sports", "축구": "sports", "야구": "sports", "농구": "sports",
    "정치": "politics", "politics": "politics",
    "철학": "philosophy", "philosophy": "philosophy", "인생": "philosophy",
    "건강": "health", "health": "health", "다이어트": "health",
};

function fallbackMapping(userInput) {
    const key = userInput.trim().toLowerCase().replace(/\s/g, "");
    if (TOPIC_MAP[key]) return TOPIC_MAP[key];
    // 부분 매칭
    for (const [k, v] of Object.entries(TOPIC_MAP)) {
        if (key.includes(k) || k.includes(key)) return v;
    }
    // 영문이면 그대로
    const cleaned = key.replace(/[^a-z0-9-]/g, "");
    return cleaned || "general";
}

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
2. 출력 조건: 소문자 영문/숫자/하이픈만 사용, 공백 없음, 최대 20자.
3. 키워드 1개만 출력. 설명, 따옴표, 부가 텍스트 절대 금지.
`;

        try {
            const response = await ai.models.generateContent({
                model: 'gemini-2.0-flash-lite',
                contents: prompt,
            });
            const raw = response.text();
            const topic = raw.trim().toLowerCase().replace(/[^a-z0-9-]/g, "");
            return {
                statusCode: 200,
                headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
                body: JSON.stringify({ topic: topic || fallbackMapping(userInput) })
            };
        } catch (aiError) {
            // 429 한도 초과 or 기타 AI 에러 → 매핑 테이블로 폴백
            console.warn("AI fallback to mapping table:", aiError.status || aiError.message);
            return {
                statusCode: 200,
                headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
                body: JSON.stringify({ topic: fallbackMapping(userInput) })
            };
        }

    } catch (error) {
        return {
            statusCode: 500,
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
            body: JSON.stringify({ topic: "general" })
        };
    }
};