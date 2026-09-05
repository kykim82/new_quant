// 브라우저의 기본 파비콘 요청을 제공 중인 SVG 아이콘으로 연결한다
export async function GET(request: Request): Promise<Response> {
  return Response.redirect(new URL('/favicon.svg', request.url), 308);
}
