import { NextRequest, NextResponse } from "next/server";

export function middleware(request: NextRequest) {
  const username = process.env.DSX_ADMIN_UI_USER?.trim();
  const password = process.env.DSX_ADMIN_UI_PASSWORD?.trim();

  if (!username || !password) {
    if (process.env.NODE_ENV === "production") {
      return new NextResponse("DSX Admin UI credentials are not configured.", { status: 503 });
    }
    return NextResponse.next();
  }

  const expected = `Basic ${btoa(`${username}:${password}`)}`;
  const supplied = request.headers.get("authorization") ?? "";

  if (supplied !== expected) {
    return new NextResponse("Authentication required.", {
      status: 401,
      headers: { "WWW-Authenticate": 'Basic realm="DSX Control Panel", charset="UTF-8"' },
    });
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
