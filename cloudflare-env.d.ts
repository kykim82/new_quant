// Cloudflare 런타임에서 제공하는 D1 바인딩 타입을 선언한다
declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
  }
}

