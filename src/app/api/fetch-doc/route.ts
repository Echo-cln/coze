import { NextRequest, NextResponse } from "next/server";
import { FetchClient, Config, HeaderUtils } from "coze-coding-dev-sdk";

export async function POST(request: NextRequest) {
  try {
    const { url } = await request.json();
    const customHeaders = HeaderUtils.extractForwardHeaders(request.headers);

    const config = new Config();
    const client = new FetchClient(config, customHeaders);

    const response = await client.fetch(url);

    const textContent = response.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n");

    return NextResponse.json({
      title: response.title,
      text: textContent,
      status_code: response.status_code,
      filetype: response.filetype,
      url: response.url,
    });
  } catch (error) {
    return NextResponse.json(
      { error: (error as Error).message },
      { status: 500 }
    );
  }
}
