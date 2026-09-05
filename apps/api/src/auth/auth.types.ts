/** Shape carried in the access-token JWT and attached to every request. */
export interface AuthPrincipal {
  userId: string;
  email: string;
}

declare module 'express' {
  interface Request {
    user?: AuthPrincipal;
  }
}

export const ACCESS_COOKIE = 'chat_at';
export const REFRESH_COOKIE = 'chat_rt';
