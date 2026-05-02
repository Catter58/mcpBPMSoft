/**
 * Authentication Manager for BPMSoft
 *
 * Handles login via AuthService.svc/Login, extracts
 * BPMSESSIONID cookie and BPMCSRF token, and provides
 * auto-reauthentication on session expiry.
 */

import type { BpmConfig, LoginResponse } from '../types/index.js';
import { HttpClient } from '../client/http-client.js';
import { AuthenticationError } from '../utils/errors.js';
import { getAuthUrl } from '../config.js';

export class AuthManager {
  private authUrl: string;

  constructor(
    private config: BpmConfig,
    private httpClient: HttpClient
  ) {
    this.authUrl = getAuthUrl(config);

    this.httpClient.setReauthHandler(() => this.login());
  }

  /**
   * Perform initial login and establish session.
   * Must be called before any OData requests.
   */
  async login(): Promise<void> {
    console.error('[AuthManager] Authenticating...');

    const response = await this.httpClient.request<LoginResponse>({
      method: 'POST',
      url: this.authUrl,
      body: {
        UserName: this.config.username,
        UserPassword: this.config.password,
      },
      skipAuth: true, // Don't try to inject CSRF for the login request itself
      contentKind: 'auth',
    });

    // BPMSoft returns HTTP 200 even on login failure — must inspect Code in body
    if (response.data.Code !== 0) {
      throw new AuthenticationError(
        `Ошибка аутентификации: ${response.data.Message || 'Unknown error'}`,
        `Code: ${response.data.Code}`
      );
    }

    const authState = this.httpClient.getAuthState();

    if (!authState.csrfToken) {
      // Some BPMSoft versions require a separate GET to obtain BPMCSRF cookie
      await this.fetchCsrfToken();
    }

    const finalState = this.httpClient.getAuthState();
    if (!finalState.csrfToken) {
      throw new AuthenticationError(
        'Не удалось получить CSRF-токен. Все последующие запросы будут отклонены сервером.',
        'BPMCSRF cookie отсутствует после аутентификации'
      );
    }

    this.httpClient.updateAuthState({ isAuthenticated: true });
    console.error('[AuthManager] Authentication successful');
  }

  /**
   * Ensure we're authenticated before making requests.
   * If not authenticated yet, performs login.
   */
  async ensureAuthenticated(): Promise<void> {
    const state = this.httpClient.getAuthState();
    if (!state.isAuthenticated) {
      await this.login();
    }
  }

  /**
   * Some BPMSoft setups require a separate request to obtain CSRF token.
   * This fetches the main application URL to collect all necessary cookies.
   */
  private async fetchCsrfToken(): Promise<void> {
    console.error('[AuthManager] Fetching CSRF token...');

    try {
      await this.httpClient.request({
        method: 'GET',
        url: this.config.bpmsoft_url,
        skipAuth: true,
      });

      const state = this.httpClient.getAuthState();
      if (!state.csrfToken) {
        console.error('[AuthManager] Warning: CSRF token not found in cookies. Some operations may fail.');
      }
    } catch {
      console.error('[AuthManager] Warning: Could not fetch CSRF token');
    }
  }
}
