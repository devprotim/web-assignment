import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { routes } from './app.routes';
import { credentialsInterceptor } from './core/credentials.interceptor';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes, withComponentInputBinding()),
    // withFetch so requests use the Fetch API; the interceptor attaches the
    // session cookie. Angular 22 is zoneless by default, so socket events are
    // reflected through signals rather than by patching async APIs.
    provideHttpClient(withFetch(), withInterceptors([credentialsInterceptor])),
  ],
};
