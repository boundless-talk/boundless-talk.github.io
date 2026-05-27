const fetch = require("node-fetch");

exports.handler = async function (event) {
    if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };

    let userInput = "";
    try {
        const body = JSON.parse(event.body);
        userInput = body.userInput || "";
    } catch (e) { return { statusCode: 400, body: "Invalid JSON" }; }

    // 1. 프롬프트를 영어로 변경하고 명확한 예시(Few-shot)를 제공합니다.
    const systemPrompt = `
You are an expert voice chat room categorizer. 
Analyze the user's input (which may be in Korean or English) and classify it into EXACTLY ONE of the allowed categories.

[ALLOWED CATEGORIES]
tesla, apple, crypto, love, ai, gaming, music, movies, travel, food, general

[STRICT RULES]
1. Translate the intent. For example, if the input is about "연애", "남자친구", "소개팅", classify as "love".
2. If the input matches a tech company like "비트코인" or "이더리움", classify as "crypto".
3. If the input does not clearly fit into the specific categories (tesla, apple, crypto, love, ai, gaming, music, movies, travel, food), you MUST output "general".
4. Output ONLY the single lowercase category name. No explanations, no punctuation, no quotes, no extra text.

[EXAMPLES]
- Input: "일론 머스크 모델Y" -> Output: tesla
- Input: "아이폰17 프로 맥스" -> Output: apple
- Input: "도지코인 언제 오르냐" -> Output: crypto
- Input: "여친이랑 싸웠어" -> Output: love
- Input: "챗GPT 활용법 알려줘" -> Output: ai
- Input: "롤 같이 할 사람" -> Output: gaming
- Input: "오늘 점심 뭐 먹지" -> Output: food
- Input: "그냥 수다 떨어요" -> Output: general
`;

    try {
        const response = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
            },
            body: JSON.stringify({
                model: "gpt-4o-mini",
                temperature: 0, // 0으로 유지하여 일관된 결과 보장
                max_tokens: 10,  // 단어 하나만 받으면 되므로 토큰 절약
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: userInput.slice(0, 100) } // 50자에서 100자로 늘려 긴 문맥도 파악하도록 수정
                ]
            })
        });

        const data = await response.json();
        let topic = data.choices?.[0]?.message?.content?.trim().toLowerCase() || "general";
        
        // 특수문자나 공백이 포함되어 넘어오는 경우를 대비한 클린징
        topic = topic.replace(/[^a-z]/g, "");

        // 추가 안전장치: 허용된 카테고리에 없으면 무조건 general
        const validTopics = ["tesla", "apple", "crypto", "love", "ai", "gaming", "music", "movies", "travel", "food", "general"];
        if (!validTopics.includes(topic)) topic = "general";

        return {
            statusCode: 200,
            headers: { 
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*" // 프론트엔드 통신 오류 방지를 위한 CORS 헤더 추가
            },
            body: JSON.stringify({ topic })
        };
    } catch (err) {
        console.error("OpenAI Fetch Error:", err);
        return { 
            statusCode: 200, 
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
            body: JSON.stringify({ topic: "general" }) 
        };
    }
};