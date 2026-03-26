import { NextResponse } from "next/server";

export async function POST(request) {
  const { prompt, maxTokens = 1000 } = await request.json();

  if (!prompt) {
    return NextResponse.json({ error: "prompt가 없습니다." }, { status: 400 });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "OPENAI_API_KEY가 설정되지 않았습니다." }, { status: 500 });
  }

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
    }),
  });

  const data = await response.json();

  if (!response.ok) {
    return NextResponse.json(
      { error: data.error?.message || "OpenAI API 오류" },
      { status: response.status }
    );
  }

  const text = data.choices?.[0]?.message?.content || "{}";
  return NextResponse.json({ text });
}
