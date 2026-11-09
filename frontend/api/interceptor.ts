import axios, { AxiosInstance, InternalAxiosRequestConfig } from 'axios';
import * as SecureStore from 'expo-secure-store';
import { ENV } from '../config/env';

// const BASE_URL = `http://${ENV.BACKEND_IP ?? 'localhost'}:${ENV.BACKEND_PORT ?? '3000'}`;
const BASE_URL = `${ENV.BACKEND_PROTOCOL}://${ENV.BACKEND_IP}:${ENV.BACKEND_PORT}`

export const apiClient: AxiosInstance = axios.create({
  baseURL: BASE_URL,
  timeout: 10000,
});

// Define holder for logout function
let onUnauthorizedCallback: (() => void) | null = null;

export const setOnUnauthorizedCallback = (callback: () => void) => {
  onUnauthorizedCallback = callback;
};

// 1. Request Interceptor: Attach Access Token to every outgoing request
apiClient.interceptors.request.use(
  async (config: InternalAxiosRequestConfig) => {
    try {
      const accessToken = await SecureStore.getItemAsync('accessToken');
      if (accessToken && config.headers) {
        config.headers.Authorization = `Bearer ${accessToken}`;
      }
    } catch (error) {
      console.error('Error retrieving access token from SecureStore', error);
    }
    return config;
  },
  (error) => Promise.reject(error)
);

// 2. Response Interceptor: Catch 401s, refresh token, and retry request
let isRefreshing = false;
let failedQueue: Array<{
  resolve: (token: string) => void;
  reject: (error: any) => void;
}> = [];

const processQueue = (error: any, token: string | null = null) => {
  failedQueue.forEach((prom) => {
    if (error) {
      prom.reject(error);
    } else {
      prom.resolve(token!);
    }
  });
  failedQueue = [];
};

apiClient.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;

    // If error is 401 and we haven't already tried retrying this request
    if (error.response?.status === 401 && !originalRequest._retry) {
      if (isRefreshing) {
        // If a refresh is already in progress, queue this request
        return new Promise((resolve, reject) => {
          failedQueue.push({ resolve, reject });
        })
          .then((token) => {
            originalRequest.headers['Authorization'] = `Bearer ${token}`;
            return apiClient(originalRequest);
          })
          .catch((err) => Promise.reject(err));
      }

      originalRequest._retry = true;
      isRefreshing = true;

      try {
        const storedRefreshToken = await SecureStore.getItemAsync('refreshToken');
        if (!storedRefreshToken) {
          throw new Error('No refresh token available');
        }

        // Request a new access token from the backend
        const response = await axios.post(`${BASE_URL}/api/auth/refresh`, {
          refreshToken: storedRefreshToken,
        });

        const { accessToken: newAccessToken } = response.data;

        // Save the new access token securely
        await SecureStore.setItemAsync('accessToken', newAccessToken);

        // Update default headers and retry pending requests
        apiClient.defaults.headers.common['Authorization'] = `Bearer ${newAccessToken}`;
        processQueue(null, newAccessToken);

        isRefreshing = false;

        // Retry original failed request
        originalRequest.headers['Authorization'] = `Bearer ${newAccessToken}`;
        return apiClient(originalRequest);
      } catch (refreshError) {
        processQueue(refreshError, null);
        isRefreshing = false;

        // Refresh token expired or is invalid -> Force Logout
        await SecureStore.deleteItemAsync('accessToken');
        await SecureStore.deleteItemAsync('refreshToken');

        // Fire the callback registered in App.tsx to reset state to null
        if (onUnauthorizedCallback) {
          onUnauthorizedCallback();
        }

        // Trigger global logout event or callback here (e.g., reset root navigation state)
        console.warn('[Auth] Session expired completely. Forcing logout.');
        
        return Promise.reject(refreshError);
      }
    }

    return Promise.reject(error);
  }
);