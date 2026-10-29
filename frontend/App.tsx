import React, { useState, useEffect } from 'react';
import {
  Text,
  View,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ActivityIndicator,
  Platform,
} from 'react-native';
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { NavigationContainer } from '@react-navigation/native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import AuthScreen from './screens/AuthScreen';
import DevicesScreen from './screens/DevicesScreen';
import VideosScreen from './screens/VideosScreen';
import { AuthState } from './types/auth.types';
import { DeviceDashboardProps } from './screens/DevicesScreen';
import { ENV } from './config/env';

const AUTH_STATE_KEY = '@app_auth_state';

export const authStorage = {
  // Save full session upon successful login/signup
  async saveSession(authData: AuthState): Promise<void> {
    try {
      // 1. Isolate high-security credentials for SecureStore
      if (authData.token) {
        await SecureStore.setItemAsync('jwt_token', authData.token);
      }
      if (authData.mqtt?.password) {
        await SecureStore.setItemAsync('mqtt_password', authData.mqtt.password);
      }

      // 2. Store non-sensitive metadata (user info, broker URL, topics) in AsyncStorage
      const publicData = {
        user: authData.user,
        mqtt: authData.mqtt ? {
          brokerUrl: authData.mqtt.brokerUrl,
          username: authData.mqtt.username,
          topics: authData.mqtt.topics,
          // password omitted here intentionally
        } : undefined,
      };

      console.log(publicData);

      await AsyncStorage.setItem(AUTH_STATE_KEY, JSON.stringify(publicData));
    } catch (error) {
      console.error('[Storage] Failed to save auth session:', error);
    }
  },

  // Rebuild the complete AuthState on app boot by stitching SecureStore and AsyncStorage together
  async getSession(): Promise<AuthState | null> {
    try {
      const storedPublicData = await AsyncStorage.getItem(AUTH_STATE_KEY);
      console.log(`STORED PUBLIC DATA ${storedPublicData}`);
      if (!storedPublicData) return null;

      const parsed = JSON.parse(storedPublicData);

      // Fetch sensitive elements from hardware-backed secure storage
      const token = (await SecureStore.getItemAsync('jwt_token')) || undefined;
      const mqttPassword = (await SecureStore.getItemAsync('mqtt_password')) || '';

      console.log(`TOKEN ${token}}`);
      console.log(`MQTT Password ${mqttPassword}`);

      if (!token) return null; // If token is missing/expired from keychain, force re-login

      return {
        user: parsed.user,
        token: token,
        mqtt: parsed.mqtt ? {
          ...parsed.mqtt,
          password: mqttPassword,
        } : undefined,
      };
    } catch (error) {
      console.error('[Storage] Failed to retrieve auth session:', error);
      return null;
    }
  },

  // Clear everything on logout or account deletion
  async clearSession(): Promise<void> {
    try {
      await SecureStore.deleteItemAsync('jwt_token');
      await SecureStore.deleteItemAsync('mqtt_password');
      await AsyncStorage.removeItem(AUTH_STATE_KEY);
    } catch (error) {
      console.error('[Storage] Failed to clear session:', error);
    }
  }
};

// const BACKEND_IP = process.env.EXPO_PUBLIC_BACKEND_IP ?? 'localhost';
// const BACKEND_PORT = process.env.EXPO_PUBLIC_BACKEND_PORT ?? '3000';
const BACKEND_URL = `http://${ENV.BACKEND_IP}:${ENV.BACKEND_PORT}`;

// const SERVICE_UUID = process.env.EXPO_PUBLIC_SERVICE_UUID ?? '';
// const SSID_CHARACTERISTIC_UUID = process.env.EXPO_PUBLIC_SSID_CHARACTERISTIC_UUID ?? '';
// const PASS_CHARACTERISTIC_UUID = process.env.EXPO_PUBLIC_PASS_CHARACTERISTIC_UUID ?? '';
// const JWT_CHARACTERISTIC_UUID = process.env.EXPO_PUBLIC_JWT_CHARACTERISTIC_UUID ?? '';
// const STATUS_CHARACTERISTIC_UUID = process.env.EXPO_PUBLIC_STATUS_CHARACTERISTIC_UUID ?? '';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const STRONG_PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!\%*?&]{8,}$/;

export default function App(): React.ReactElement {
  const [authState, setAuthState] = useState<AuthState | null>(null);
  const [isInitializing, setIsInitializing] = useState<boolean>(true);

  // Check storage on cold app start
  useEffect(() => {
    async function restoreSession() {
      try {
        const savedSession = await authStorage.getSession();
        console.log(savedSession);
        if (savedSession) {
          setAuthState(savedSession);
        }
      } catch (e) {
        console.log('[App] No active session found.');
      } finally {
        setIsInitializing(false);
      }
    }
    restoreSession();
  }, []);

  if (isInitializing) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#0b0f19' }}>
        <ActivityIndicator size="large" color="#3b82f6" />
      </View>
    );
  }

  if (!authState) {
    return (
      <AuthScreen 
        onAuthSuccess={async (data: AuthState) => {
          await authStorage.saveSession(data); // Persist securely on login
          setAuthState(data);
        }} 
      />
    );
  }

  return (
    <NavigationContainer>
      <MainDashboardNavigator 
        authState={authState} 
        onLogout={async () => {
          await authStorage.clearSession(); // Wipe secure data on logout
          setAuthState(null);
        }} 
      />
    </NavigationContainer>
  );
}

const Tab = createBottomTabNavigator();

function MainDashboardNavigator({ authState, onLogout }: DeviceDashboardProps) {
  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: '#121826',
          borderTopColor: '#1e293b',
          height: 65,
          paddingBottom: 8,
          paddingTop: 8,
        },
        tabBarActiveTintColor: '#3b82f6',
        tabBarInactiveTintColor: '#64748b',
        tabBarLabelStyle: {
          fontSize: 112,
          fontWeight: '600',
        },
      }}
    >
      <Tab.Screen 
        name="Devices"
        options={{
          tabBarLabel: 'Devices',
          tabBarIcon: ({ color, size }) => (
            <MaterialCommunityIcons name="memory" size={size} color={color} />
          ),
        }}
      >
        {(props) => <DevicesScreen {...props} authState={authState} onLogout={onLogout} />}
      </Tab.Screen>

      <Tab.Screen 
        name="Videos"
        options={{
          tabBarLabel: 'Videos',
          tabBarIcon: ({ color, size }) => (
            <MaterialCommunityIcons name="video-outline" size={size} color={color} />
          ),
        }}
      >
        {(props) => <VideosScreen {...props} authState={authState} />}
      </Tab.Screen>
    </Tab.Navigator>
  );
}