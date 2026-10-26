import React, { useState, useEffect, useRef } from 'react';
import {
  Text,
  View,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ActivityIndicator,
  FlatList,
  Modal,
  Platform,
  PermissionsAndroid,
  ListRenderItem
} from 'react-native';
import { BleManager, Device, Subscription, BleError } from 'react-native-ble-plx';
import { Buffer } from 'buffer';
import mqtt, { MqttClient, IClientOptions } from 'mqtt';
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';

export interface MqttCredentials {
  brokerUrl: string;
  username: string;
  password: string;
  topics: {
    telemetrySubscribe: string;
    commandPublish: string;
    statusSubscribe: string;
  }
}

export interface User {
  id: string | number;
  username: string;
  email: string;
}

export interface AuthState {
  user: User;
  token?: string;
  mqtt?: MqttCredentials;
}

export interface DeviceItem {
  id: string;
  device_name: string;
}

interface AuthScreenProps {
  onAuthSuccess: (authData: AuthState) => void;
}

interface DeviceDashboardProps {
  authState: AuthState;
  onLogout: () => void;
}

interface AddDeviceBLEModalProps {
  user: User;
  onClose: () => void;
  onSuccess: () => void;
}

interface SessionState {
  isFinished: boolean;
}

interface DeviceCommand {
  label: string;
  actionValue: string;
  buttonColor?: string;
}

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

const AVAILABLE_COMMANDS: DeviceCommand[] = [
  { label: 'StreamSwitch On', actionValue: 'STREAMSWITCH_ON', buttonColor: '#007AFF' },
  { label: 'StreamSwitch Off', actionValue: 'STREAMSWITCH_OFF', buttonColor: '#d9534f' },
  { label: 'Reboot Device', actionValue: 'REBOOT', buttonColor: '#f0ad4e' },
  // { label: 'Calibrate Sensor', actionValue: 'CALIBRATE', buttonColor: '#5cb85c' },
];

const bleManager = new BleManager();

const BACKEND_IP = process.env.EXPO_PUBLIC_BACKEND_IP ?? 'localhost';
const BACKEND_PORT = process.env.EXPO_PUBLIC_BACKEND_PORT ?? '3000';
const BACKEND_URL = `http://${BACKEND_IP}:${BACKEND_PORT}`;

const SERVICE_UUID = process.env.EXPO_PUBLIC_SERVICE_UUID ?? '';
const SSID_CHARACTERISTIC_UUID = process.env.EXPO_PUBLIC_SSID_CHARACTERISTIC_UUID ?? '';
const PASS_CHARACTERISTIC_UUID = process.env.EXPO_PUBLIC_PASS_CHARACTERISTIC_UUID ?? '';
const JWT_CHARACTERISTIC_UUID = process.env.EXPO_PUBLIC_JWT_CHARACTERISTIC_UUID ?? '';
const STATUS_CHARACTERISTIC_UUID = process.env.EXPO_PUBLIC_STATUS_CHARACTERISTIC_UUID ?? '';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const STRONG_PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!\%*?&]{8,}$/;

// ----------------------------------------------------------------------------
// CUSTOM HOOK: MQTT MANAGEMENT
// ----------------------------------------------------------------------------
function useMQTT(mqttInfo?: MqttCredentials) {
  const [isConnected, setIsConnected] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const clientRef = useRef<MqttClient | null>(null);

  useEffect(() => {
    if (!mqttInfo || !mqttInfo.brokerUrl || !mqttInfo.username) {
      return;
    }

    let isMounted = true;

    async function initMqttClient(config: MqttCredentials) {
      try {
        setError(null);

        // Parse host and port (e.g. "wss://192.168.1.50:9001" or "192.168.1.50:9001")
        // const rawUrl = config.brokerUrl.replace(/^ws?:\/\//, '').replace(/^mqtts?:\/\//, '');
        // const [host, portStr] = rawUrl.split(':');
        // const port = portStr ? parseInt(portStr, 10) : 9001; // Default WS port

        const options: IClientOptions = {
          // path: '/mqtt',
           path: '/', // Mosquitto WebSocket path
          username: config.username,
          password: config.password,
          clientId: `app_${config.username}_${Math.random().toString(16).substring(2, 8)}`,
          rejectUnauthorized: true,
          clean: true,
          reconnectPeriod: 5000,
          connectTimeout: 10000,
        };

        // const brokerUrl = `ws://${host}:${port}/`;

        // const brokerUrl = "wss://situation-rephrase-cusp.ngrok-free.dev";
        console.log(`[MQTT] Connecting to ${config.brokerUrl}...`);

        const client = mqtt.connect(config.brokerUrl, options);
        clientRef.current = client;

        client.on('connect', () => {
          if (isMounted) {
            console.log('[MQTT] Connected successfully via MQTTS');
            setIsConnected(true);
            setError(null);
          }
        });

        client.on('error', (err) => {
          console.error('[MQTT] Socket error:', err);
          if (isMounted) {
            setError(err.message || 'MQTT Connection Error');
          }
        });

        client.on('offline', () => {
          if (isMounted) {
            setIsConnected(false);
          }
        });
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : 'MQTT Init Exception';
        console.error('[MQTT] Init Exception:', errorMsg);
        if (isMounted) {
          setError(errorMsg);
        }
      }
    }

    initMqttClient(mqttInfo);

    return () => {
      isMounted = false;
      if (clientRef.current) {
        console.log('[MQTT] Disconnecting client...');
        clientRef.current.end(true);
        clientRef.current = null;
      }
    };
  }, [mqttInfo?.brokerUrl, mqttInfo?.username, mqttInfo?.password]);

  const publish = (topic: string, message: object | string) => {
    if (clientRef.current && isConnected) {
      const payload = typeof message === 'string' ? message : JSON.stringify(message);
      clientRef.current.publish(topic, payload, { qos: 1 });
    } else {
      console.warn('[MQTT] Cannot publish: Client is disconnected');
    }
  };

  return { client: clientRef.current, isConnected, error, publish };
}

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
    <DeviceDashboard 
      authState={authState} 
      onLogout={async () => {
        await authStorage.clearSession(); // Wipe secure data on logout
        setAuthState(null);
      }} 
    />
  );
}

// ----------------------------------------------------------------------------
// COMBINED AUTH SCREEN (SIGNUP & LOGIN)
// ----------------------------------------------------------------------------
function AuthScreen({ onAuthSuccess }: AuthScreenProps): React.ReactElement {
  const [isLoginMode, setIsLoginMode] = useState<boolean>(true);
  const [username, setUsername] = useState<string>('');
  const [email, setEmail] = useState<string>('');
  const [password, setPassword] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(false);

  const toggleAuthMode = () => {
    setIsLoginMode((prev) => !prev);
    setUsername('');
    setEmail('');
    setPassword('');
  };

  const handleAuthSubmit = async (): Promise<void> => {
    if (!email || !password) {
      Alert.alert('Error', 'Please fill in all fields.');
      return;
    }

    if (!EMAIL_REGEX.test(email)) {
      Alert.alert('Validation Error', 'Please enter a valid email address.');
      return;
    }

    if (!isLoginMode){
      if (!username.trim()) {
        Alert.alert('Validation Error', 'Username is required for registration.');
        return;
      }

      if (!STRONG_PASSWORD_REGEX.test(password)) {
        Alert.alert(
          'Validation Error',
          'Password must be 8+ characters and contain uppercase, lowercase, number, & special character.'
        );
        return;
      }

    }

    setLoading(true);

    const endpoint = isLoginMode ? '/api/auth/login' : '/api/auth/signup';
    const payload = isLoginMode ? { email, password } : { username, email, password };

    try {
      const response = await fetch(`${BACKEND_URL}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await response.json();

      if (response.ok) {
        Alert.alert('Success', isLoginMode ? 'Logged in successfully!' : 'Account created successfully!');

        // Pass full AuthState (user, token, mqtt credentials) to parent
        onAuthSuccess({
          user: data.user,
          token: data.token,
          mqtt: data.mqtt,
        });
      } else {
        Alert.alert('Authentication Failed', data.error || 'Something went wrong');
      }
    } catch (error) {
      Alert.alert('Network Error', 'Could not connect to backend service.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.brandTitle}>KRONOS</Text>
      <Text style={styles.title}>{isLoginMode ? 'Welcome Back' : 'Create Account'}</Text>
      <Text style={styles.subtitle}>{isLoginMode ? 'Sign in to monitor your IoT edge devices' : 'Register to get started'}</Text>

      <View style={styles.form}>
        {!isLoginMode && (<TextInput
          style={styles.input}
          placeholder="Username"
          placeholderTextColor="#64748b"
          value={username}
          onChangeText={setUsername}
          autoCapitalize="none"
          editable={!loading}
        />
        )}
        <TextInput
          style={styles.input}
          placeholder="Email Address"
          placeholderTextColor="#64748b"
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          keyboardType="email-address"
          editable={!loading}
        />
        <TextInput
          style={styles.input}
          placeholder="Password"
          placeholderTextColor="#64748b"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          editable={!loading}
        />

        <TouchableOpacity style={styles.button} onPress={handleAuthSubmit} disabled={loading}>
          {loading ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.buttonText}>{isLoginMode ? 'Log In' : 'Sign Up'}</Text>
          )}
        </TouchableOpacity>

        <TouchableOpacity style={styles.toggleButton} onPress={toggleAuthMode} disabled={loading}>
          <Text style={styles.toggleButtonText}>
            {isLoginMode
              ? "Don't have an account? Sign Up"
              : 'Already have an account? Log In'}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ----------------------------------------------------------------------------
// DASHBOARD SCREEN
// ----------------------------------------------------------------------------
function DeviceDashboard({ authState, onLogout }: DeviceDashboardProps) {
  const { user, mqtt: mqttInfo } = authState;
  const [devices, setDevices] = useState<DeviceItem[]>([]);
  const [fetching, setFetching] = useState<boolean>(true);
  const [modalVisible, setModalVisible] = useState<boolean>(false);

  const [selectedDevice, setSelectedDevice] = useState<DeviceItem | null>(null);

  // Store telemetry for ALL devices mapped by deviceId: { [deviceId]: payload }
  const [deviceTelemetryMap, setDeviceTelemetryMap] = useState<Record<string, any>>({});

  // Store status for ALL devices mapped by deviceId: { [deviceId]: status }
  const [deviceStatusMap, setDeviceStatusMap] = useState<Record<string, string>>({});

  // Track timestamp of the last received packet per device to calculate timeouts
  const deviceLastSeenRef = useRef<Record<string, number>>({});

  // Initialize MQTT over TLS automatically using auth credentials
  const { client, isConnected, error: mqttError } = useMQTT(mqttInfo);

  useEffect(() => {
    fetchDevices();
  }, []);

  // Watchdog timer to flag devices as offline if no message received for 15 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      setDeviceStatusMap((prevStatus) => {
        let updated = false;
        const nextStatus = { ...prevStatus };

        Object.keys(nextStatus).forEach((deviceId) => {
          const lastSeen = deviceLastSeenRef.current[deviceId] || 0;

          // If active for more than 15 seconds without communication, set offline
          if (nextStatus[deviceId] === 'online' && now - lastSeen > 15000) {
            nextStatus[deviceId] = 'offline';
            updated = true;
          }
        });

        return updated ? nextStatus : prevStatus;
      });
    }, 5000); // Check every 5 seconds

    return () => clearInterval(interval);
  }, []);

  // Handle MQTT subscriptions and incoming messages
  useEffect(() => {
    if (!client || !isConnected || !mqttInfo) return;

    const topicsToSubscribe = [
      mqttInfo.topics.telemetrySubscribe,
      mqttInfo.topics.statusSubscribe,
    ].filter(Boolean);

    topicsToSubscribe.forEach((topic) => {
      client.subscribe(topic, { qos: 1 }, (err) => {
        if (err) console.error(`[MQTT] Subscription error for ${topic}:`, err);
        else console.log(`[MQTT] Subscribed to ${topic}`);
      });
    });

    const handleMessage = (topic: string, payload: Buffer) => {
      try {
        const messageStr = payload.toString('utf-8');
        const data = JSON.parse(messageStr);

        const segments= topic.split('/');
        const deviceIdIndex = segments.indexOf('devices') + 1;

        if (deviceIdIndex > 0 && segments[deviceIdIndex]) {
          const deviceId = segments[deviceIdIndex];
          const subType = segments[segments.length - 1];

          // Update last seen timestamp
          deviceLastSeenRef.current[deviceId] = Date.now();

          if (subType === 'telemetry') {
            setDeviceTelemetryMap((prev) => ({ ...prev, [deviceId]: data }));
          } else if (subType === 'status') {
            const statusValue = typeof data === 'object' ? (data.status || 'online') : data;
            setDeviceStatusMap((prev) => ({ ...prev, [deviceId]: statusValue }));
          }
        }
      } catch (e) {
        console.warn(`[MQTT Parse Error] Topic ${topic}:`, e);
      }
    };

    client.on('message', handleMessage);

    return () => {
      client.off('message', handleMessage);
      topicsToSubscribe.forEach((topic) => {
        if (client.connected) client.unsubscribe(topic);
      });
    };
  }, [client, isConnected, mqttInfo]);

  const fetchDevices = async (): Promise<void> => {
    try {
      const response = await fetch(`${BACKEND_URL}/api/devices/${user.id}`);
      const data = await response.json();
      if (response.ok) {
        setDevices(data.devices || []);
      }
    } catch (err) {
      Alert.alert('Error', 'Failed to load user devices.');
    } finally {
      setFetching(false);
    }
  };

  // Construct dynamic command topic using your template format:
  const handleSendCommand = (actionValue: string) => {
    if (!selectedDevice || !mqttInfo || !client) return;
    
    const commandTopic = mqttInfo.topics.commandPublish.replace('{deviceId}', selectedDevice.id);
    const payload = JSON.stringify({ 
      command: actionValue, 
      timestamp: Date.now() 
    });
  
    // Call publish directly on the mqtt client instance
    client.publish(commandTopic, payload, { qos: 1 }, (err) => {
      if (err) {
        Alert.alert('Error', 'Failed to send command.');
      } else {
        Alert.alert('Command Sent', `Sent '${actionValue}' to ${selectedDevice.device_name}`);
      }
    });
  };

  const handleDeleteDevice = (deviceId: string, deviceName: string) => {
    Alert.alert(
      'Delete Device',
      `Are you sure you want to remove "${deviceName}"?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              const response = await fetch(`${BACKEND_URL}/api/devices/${user.id}/${deviceId}`, {
                method: 'DELETE',
              });
              
              if (response.ok) {
                // Remove the device from local state immediately
                setDevices((prevDevices) => prevDevices.filter((d) => d.id !== deviceId));
                
                // If the currently selected device is the one being deleted, close the panel
                if (selectedDevice?.id === deviceId) {
                  setSelectedDevice(null);
                }
                
                Alert.alert('Success', 'Device removed successfully.');
              } else {
                Alert.alert('Error', 'Failed to delete the device on the server.');
              }
            } catch (err) {
              Alert.alert('Error', 'Network error while deleting device.');
            }
          },
        },
      ]
    );
  };

  const handleDeleteAccount = () => {
    Alert.alert(
      'Delete Account',
      'Permanently delete your account and associated devices? This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete Permanently',
          style: 'destructive',
          onPress: async () => {
            try {
              // Assuming authState contains the JWT token and user ID
              const response = await fetch(`${BACKEND_URL}/api/users/${user.id}`, {
                method: 'DELETE',
                headers: {
                  'Authorization': `Bearer ${authState.token}`, // Pass your token for security
                },
              });

              if (response.ok) {
                // Alert.alert('Account Deleted', 'Your account has been successfully removed.');
                onLogout(); // Clears authState and returns to login screen
              } else {
                Alert.alert('Error', 'Failed to delete account on the server.');
              }
            } catch (err) {
              // console.error('Account deletion error:', err);
              Alert.alert('Error', 'Network error while attempting to delete account.');
            }
          },
        },
      ]
    );
  };

  const renderDeviceItem: ListRenderItem<DeviceItem> = ({ item }) => {
    const isSelected = selectedDevice?.id === item.id;
    const liveStatus = deviceStatusMap[item.id] || 'offline';
    const isOnline = liveStatus.toLowerCase() === 'online';
    
    return (
      <TouchableOpacity 
        style={[styles.deviceCard, isSelected && styles.selectedDeviceCard]}
        onPress={() => setSelectedDevice(item)}
      >
        <View style={styles.cardHeaderRow}>
          <View>
            <Text style={styles.deviceName}>{item.device_name}</Text>
            {/* Status Indicator Dot */}
            <View style={styles.statusIndicatorContainer}>
              <View style={[styles.dot, { backgroundColor: isOnline ? '#10b981' : '#ef4444' }]} />
              <Text style={[styles.onlineStatusText, { color: isOnline ? '#34d399' : '#f87171' }]}>
                {isOnline ? 'Online' : 'Offline'}
              </Text>
            </View>
          </View>

          {/* Delete Button */}
          <TouchableOpacity 
            style={styles.deleteButton} 
            onPress={(e) => {
              // e.stopPropagation ensures clicking delete doesn't trigger the card's onPress selection
              e.stopPropagation?.();
              handleDeleteDevice(item.id, item.device_name);
            }}
          >
            <Text>🗑️</Text>
          </TouchableOpacity>
        </View>
      </TouchableOpacity>
    );
  };

  const renderTelemetryData = (telemetryObj: any) => {
    if (!telemetryObj || typeof telemetryObj !== 'object') {
      return <Text style={styles.telemetryPlaceholder}>Waiting for telemetry metrics...</Text>;
    }

    return (
      <View style={styles.telemetryGrid}>
        {Object.entries(telemetryObj).map(([key, value]) => (
          <View key={key} style={styles.telemetryCard}>
            <Text style={styles.telemetryKey}>{key.replace(/_/g, ' ').toUpperCase()}</Text>
            <Text style={styles.telemetryValue}>{String(value)}</Text>
          </View>
        ))}
      </View>
    );
  };

  return (
    <View style={styles.dashboardContainer}>
      <View style={styles.headerRow}>
        <View>
          <Text style={styles.greetingLabel}>CONNECTED USER</Text>
          <Text style={styles.welcomeText}>{user.username}</Text>
        </View>
  
        <View style={styles.headerActionsRow}>
          <TouchableOpacity onPress={handleDeleteAccount} style={[styles.actionButton, styles.deleteButtonOutline]}>
            <Text style={styles.deleteButtonText}>Delete</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={onLogout} style={[styles.actionButton, styles.logoutButtonOutline]}>
            <Text style={styles.logoutButtonText}>Logout</Text>
          </TouchableOpacity>
        </View>
      </View>

      <View style={styles.statusBadge}>
        <View style={[styles.dot, { backgroundColor: isConnected ? '#10b981' : '#f59e0b' }]} />
        <Text style={styles.statusLabel}>MQTT Broker: </Text>
        {isConnected ? (
          <Text style={styles.statusConnected}>Connected</Text>
        ) : (
            <ActivityIndicator size="small" color="#3b82f6" style={{ marginLeft: 6 }} />
        )}
      </View>

      <TouchableOpacity style={styles.addButton} onPress={() => setModalVisible(true)}>
        <Text style={styles.addButtonText}>+ Add Edge Device (BLE)</Text>
      </TouchableOpacity>

      <Text style={styles.sectionTitle}>Your Devices</Text>

      {fetching ? (
        <ActivityIndicator color="#3b82f6" style={{ marginTop: 20 }} />
      ) : (
        <FlatList
          data={devices}
          keyExtractor={(item: DeviceItem) => item.id}
          renderItem={renderDeviceItem}
          ListEmptyComponent={<Text style={styles.emptyText}>No devices added yet.</Text>}
          contentContainerStyle={{ paddingBottom: 20 }}
        />
      )}

      {selectedDevice && (
        <View style={styles.selectedPanel}>
          <View style={styles.panelHeader}>
            <Text style={styles.panelTitle}>Control: {selectedDevice.device_name}</Text>
            <TouchableOpacity onPress={() => setSelectedDevice(null)}>
              <Text style={styles.closePanelText}>Close</Text>
            </TouchableOpacity>
          </View>
            
          <Text style={styles.panelSubHeader}>Live Telemetry Metrics</Text>
          <View style={styles.telemetryContainer}>
            {renderTelemetryData(deviceTelemetryMap[selectedDevice.id])}
          </View>

          <Text style={styles.panelSubHeader}>Actions & Commands</Text>
          <View style={styles.commandGrid}>
            {AVAILABLE_COMMANDS.map((cmd) => (
              <TouchableOpacity 
                key={cmd.actionValue}
                style={[styles.gridButton, { backgroundColor: cmd.buttonColor || '#2563eb' }]} 
                onPress={() => handleSendCommand(cmd.actionValue)}
                activeOpacity={0.8}
              >
                <Text style={styles.buttonText}>{cmd.label}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      )}

      <Modal visible={modalVisible} animationType="slide">
        <AddDeviceBLEModal
          user={user}
          onClose={() => setModalVisible(false)}
          onSuccess={() => {
            setModalVisible(false);
            fetchDevices();
          }}
        />
      </Modal>
    </View>
  );
}

// ----------------------------------------------------------------------------
// BLE MODAL (Using JWT Setup Token)
// ----------------------------------------------------------------------------
function AddDeviceBLEModal({ user, onClose, onSuccess }: AddDeviceBLEModalProps) {
  const [deviceName, setDeviceName] = useState<string>('');
  const [wifiSsid, setWifiSsid] = useState<string>('');
  const [wifiPassword, setWifiPassword] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(false);
  const [statusText, setStatusText] = useState<string>('');

  const requestBLEPermissions = async (): Promise<boolean> => {
    if (Platform.OS === 'android') {
      // Android 12+ (API 31+) requires explicit Bluetooth permissions
      if (Platform.Version >= 31) {
        const result = await PermissionsAndroid.requestMultiple([
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
        ]);

        return (
          result[PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN] === PermissionsAndroid.RESULTS.GRANTED &&
          result[PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT] === PermissionsAndroid.RESULTS.GRANTED &&
          result[PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION] === PermissionsAndroid.RESULTS.GRANTED
        );
      } 
      // Android 11 and lower require Fine Location permission to perform BLE scans
      else {
        const granted = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION
        );
        return granted === PermissionsAndroid.RESULTS.GRANTED;
      }
    }

    // iOS permissions are handled automatically via Info.plist at runtime
    return true;
  }

  const handleStartOnboarding = async (): Promise<void> => {

    const sessionState: SessionState = { isFinished: false };

    if (!deviceName.trim() || !wifiSsid.trim()) {
      Alert.alert('Validation Error', 'Device Name and Wi-Fi SSID are required.');
      return;
    }

   // Request runtime BLE permissions prior to executing scan/API calls
    const hasPermission = await requestBLEPermissions();
    if (!hasPermission) {
      Alert.alert('Permission Denied', 'Bluetooth and Location permissions are required.');
      return;
    }
    
    setLoading(true);

    try {
      // Step 1: Request signed JWT setup token from Express
      setStatusText('Generating JWT setup token...');
      const response = await fetch(`${BACKEND_URL}/api/devices/request-setup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user.id, deviceName }),
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to request setup');

      const jwtToken = data.setupToken; // Signed JWT token

      let isProcessingDevice = false;

      // Step 2: Scan for BLE Hardware
      setStatusText('Scanning for BLE hardware...');
      bleManager.startDeviceScan(
        [SERVICE_UUID], 
        null, 
        async (error: BleError | null, device: Device | null) => {
          if (error) {
            bleManager.stopDeviceScan();
            setLoading(false);
            Alert.alert('BLE Error', error.message);
            return;
          }

          if (device && !isProcessingDevice) {
            isProcessingDevice = true;
            bleManager.stopDeviceScan();
            let statusSubscription: Subscription | null = null;

            try {
              setStatusText('Connecting via BLE...');

              const connectedDevice = await device.connect();
              await connectedDevice.discoverAllServicesAndCharacteristics();

              // Listen for status updates
              statusSubscription = bleManager.monitorCharacteristicForDevice(
                connectedDevice.id,
                SERVICE_UUID,
                STATUS_CHARACTERISTIC_UUID,
                (charError: BleError | null, characteristic) => {
                  if (charError) {

                    if (sessionState.isFinished) return;

                    // const errorMsg = charError.message || '';
                    // const errorCode = charError.errorCode;

                    // if (
                    //   errorCode === 2 ||
                    //   errorCode === 201 ||
                    //   errorMsg.toLowerCase().includes('cancel') ||
                    //   errorMsg.toLowerCase().includes('disconnect')
                    // ) {
                    //   // console.log('[BLE] Cleanly suppressed cancellation/teardown error:', errorMsg);
                    //   return;
                    // }

                    // console.error('[BLE Subscription Error]:', charError);
                    return;
                  }

                  if (characteristic?.value) {
                    const liveStatus = Buffer.from(characteristic.value, 'base64').toString('utf-8');
                    // console.log('[BLE Live Status]:', liveStatus);
                    setStatusText(`Device Status: ${liveStatus}`);

                    if (liveStatus === 'SUCCESS') {
                      sessionState.isFinished = true

                      if (statusSubscription){
                        statusSubscription.remove();
                        statusSubscription = null
                      }
                      setLoading(false);
                      Alert.alert('Success', 'Edge device provisioned successfully!');
                      onSuccess();
                    } else if (liveStatus.startsWith('ERROR_')) {
                      sessionState.isFinished = true;

                      if (statusSubscription){
                        statusSubscription.remove();
                        statusSubscription = null
                      }
                      setLoading(false);
                      Alert.alert('Provisioning Error', `Hardware reported error: ${liveStatus}`);
                    }
                  }
                }
              )
              await new Promise((resolve) => setTimeout(resolve, 300));

              // Step 3: Transmit Wi-Fi Credentials + JWT Payload
              // setStatusText('Sending SSID...');
              const ssidBase64 = Buffer.from(wifiSsid).toString('base64');
              await connectedDevice.writeCharacteristicWithResponseForService(
                SERVICE_UUID,
                SSID_CHARACTERISTIC_UUID,
                ssidBase64
              );

              // setStatusText('Sending Password...');
              const passBase64 = Buffer.from(wifiPassword).toString('base64');
              await connectedDevice.writeCharacteristicWithResponseForService(
                SERVICE_UUID,
                PASS_CHARACTERISTIC_UUID,
                passBase64
              );

              // setStatusText('Sending Token...');
              const negotiatedDevice = await connectedDevice.requestMTU(512);
              const chunkSize = negotiatedDevice.mtu;
              // const totalChunks = Math.ceil(jwtToken.length / chunkSize);
              for (let i = 0; i < jwtToken.length; i += chunkSize) {
                const currentChunkNumber = Math.floor(i / chunkSize) + 1;
                const chunk = jwtToken.slice(i, i + chunkSize);
                const chunkBase64 = Buffer.from(chunk, 'utf-8').toString('base64');

                // console.log(`[BLE] Writing JWT chunk ${currentChunkNumber}/${totalChunks}...`);

                await connectedDevice.writeCharacteristicWithResponseForService(
                  SERVICE_UUID,
                  JWT_CHARACTERISTIC_UUID,
                  chunkBase64
                );
              }

              // 2. Send __EOF__ marker to signal transmission completion
              // console.log('Finalizing Token...');
              const eofBase64 = Buffer.from('__EOF__', 'utf-8').toString('base64');
              await connectedDevice.writeCharacteristicWithResponseForService(
                SERVICE_UUID,
                JWT_CHARACTERISTIC_UUID,
                eofBase64
              );

              setStatusText('Waiting for hardware to connect to Wi-Fi...');

              // 6. Fail-safe timeout in case physical BLE notification gets dropped
              setTimeout(() => {
                if (!sessionState.isFinished) {
                  if (statusSubscription) {
                    statusSubscription.remove();
                    statusSubscription = null;
                  } 
                  setLoading(false);
                  Alert.alert('Timeout', 'Hardware did not respond in time.');
                  }
                }, 35000);
            } catch (innerErr: unknown) {
              if (!sessionState.isFinished){
                if (statusSubscription){
                  statusSubscription.remove();
                  statusSubscription = null;
                }
                setLoading(false);
                const errorMessage = innerErr instanceof Error ? innerErr.message : 'Unknown provisioning error';
                Alert.alert('Provisioning Error', errorMessage);
              }
            }
          }
        }
      );
    } catch (err: unknown) {
      setLoading(false);
      const errorMessage = err instanceof Error ? err.message : 'Unknown onboarding error';
      Alert.alert('Provisioning Failed', errorMessage);
    }
  };

  return (
    <View style={styles.modalContainer}>
      <View style={styles.modalContentWrapper}>
        <Text style={styles.modalTitle}>Provision Edge Device</Text>
        <Text style={styles.subtitle}>Setup secure Bluetooth link & Wi-Fi parameters</Text>

        <TextInput
          style={styles.input}
          placeholder="Device Name (e.g., Gateway Node 01)"
          placeholderTextColor="#64748b"
          value={deviceName}
          onChangeText={setDeviceName}
          editable={!loading}
        />
        <TextInput
          style={styles.input}
          placeholder="Wi-Fi SSID"
          placeholderTextColor="#64748b"
          value={wifiSsid}
          onChangeText={setWifiSsid}
          autoCapitalize="none"
          editable={!loading}
        />
        <TextInput
          style={styles.input}
          placeholder="Wi-Fi Password"
          placeholderTextColor="#64748b"
          value={wifiPassword}
          onChangeText={setWifiPassword}
          secureTextEntry
          editable={!loading}
        />

          {loading && <Text style={styles.statusText}>{statusText}</Text>}

        <TouchableOpacity
          style={[styles.button, loading && styles.disabledButton]}
          onPress={handleStartOnboarding}
          disabled={loading}
          activeOpacity={0.8}
        >
          {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Pair & Transmit over BLE</Text>}
        </TouchableOpacity>

        <TouchableOpacity style={styles.cancelButton} onPress={onClose} disabled={loading}>
          <Text style={styles.cancelButtonText}>Cancel</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}
// ----------------------------------------------------------------------------
// STYLES (Dark, Sleek, Modern Theme)
// ----------------------------------------------------------------------------
const styles = StyleSheet.create({
  container: { 
    flex: 1, 
    justifyContent: 'center', 
    padding: 24, 
    backgroundColor: '#0b0f19' 
  },
  authCardWrapper: {
    backgroundColor: '#121826',
    borderRadius: 16,
    padding: 24,
    borderWidth: 1,
    borderColor: '#1e293b',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.5,
    shadowRadius: 15,
    elevation: 10,
  },
  dashboardContainer: { 
    flex: 1, 
    padding: 20, 
    paddingTop: 60, 
    backgroundColor: '#0b0f19' 
  },
  modalContainer: { 
    flex: 1, 
    justifyContent: 'center', 
    padding: 24, 
    backgroundColor: '#0b0f19' 
  },
  modalContentWrapper: {
    backgroundColor: '#121826',
    borderRadius: 16,
    padding: 24,
    borderWidth: 1,
    borderColor: '#1e293b',
  },
  brandTitle: {
    fontSize: 12,
    letterSpacing: 3,
    color: '#3b82f6',
    fontWeight: 'bold',
    marginBottom: 6,
    textAlign: 'center',
  },
  title: { 
    fontSize: 24, 
    fontWeight: 'bold', 
    color: '#f8fafc',
    marginBottom: 6,
    textAlign: 'center' 
  },
  modalTitle: { 
    fontSize: 22, 
    fontWeight: 'bold', 
    color: '#f8fafc',
    marginBottom: 6,
    textAlign: 'center' 
  },
  subtitle: {
    fontSize: 14,
    color: '#94a3b8',
    textAlign: 'center',
    marginBottom: 24,
  },
  form: { 
    width: '100%' 
  },
  input: { 
    color: '#f8fafc', 
    borderWidth: 1, 
    borderColor: '#1e293b', 
    borderRadius: 10, 
    padding: 14, 
    marginBottom: 16, 
    fontSize: 15, 
    backgroundColor: '#1a2234',
    fontFamily: Platform.OS === 'android' ? 'normal' : undefined
  },
  button: { 
    backgroundColor: '#3b82f6', 
    padding: 15, 
    borderRadius: 10, 
    alignItems: 'center',
    shadowColor: '#3b82f6',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 5,
  },
  disabledButton: { 
    backgroundColor: '#1e3a8a' 
  },
  buttonText: { 
    color: '#ffffff', 
    fontSize: 16, 
    fontWeight: '600' 
  },
  toggleButton: { 
    marginTop: 20, 
    alignItems: 'center' 
  },
  toggleButtonText: { 
    color: '#60a5fa', 
    fontSize: 14, 
    fontWeight: '500' 
  },
  headerRow: { 
    flexDirection: 'row', 
    justifyContent: 'space-between', 
    alignItems: 'center', 
    marginBottom: 16 
  },
  greetingLabel: {
    fontSize: 10,
    color: '#64748b',
    letterSpacing: 1,
    fontWeight: '700',
  },
  welcomeText: { 
    fontSize: 20, 
    fontWeight: 'bold',
    color: '#f8fafc' 
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#121826',
    borderWidth: 1,
    borderColor: '#1e293b',
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 10,
    marginBottom: 16,
  },
  statusLabel: { 
    fontSize: 13, 
    fontWeight: '600', 
    color: '#94a3b8',
    marginLeft: 8,
  },
  statusConnected: { 
    fontSize: 13, 
    color: '#34d399', 
    fontWeight: 'bold' 
  },
  addButton: { 
    backgroundColor: '#059669', 
    padding: 15, 
    borderRadius: 10, 
    alignItems: 'center', 
    marginBottom: 20,
    shadowColor: '#059669',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 4,
  },
  addButtonText: { 
    color: '#ffffff', 
    fontSize: 15, 
    fontWeight: 'bold' 
  },
  sectionTitle: { 
    fontSize: 16, 
    fontWeight: 'bold', 
    color: '#cbd5e1',
    marginBottom: 12,
    letterSpacing: 0.5,
  },
  deviceCard: { 
    backgroundColor: '#121826', 
    padding: 16, 
    borderRadius: 12, 
    marginBottom: 12, 
    borderWidth: 1, 
    borderColor: '#1e293b' 
  },
  selectedDeviceCard: {
    borderColor: '#3b82f6',
    backgroundColor: '#162238',
    borderWidth: 1.5,
  },
  deviceName: { 
    fontSize: 16, 
    fontWeight: 'bold',
    color: '#f8fafc' 
  },
  emptyText: { 
    textAlign: 'center', 
    color: '#64748b', 
    marginTop: 20,
    fontStyle: 'italic'
  },
  statusText: { 
    color: '#60a5fa', 
    textAlign: 'center', 
    marginVertical: 12, 
    fontStyle: 'italic',
    fontSize: 13,
  },
  cancelButton: { 
    marginTop: 16, 
    alignItems: 'center' 
  },
  cancelButtonText: { 
    color: '#94a3b8', 
    fontSize: 15,
    fontWeight: '500' 
  },
  selectedPanel: {
    marginTop: 15,
    padding: 16,
    backgroundColor: '#121826',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#1e293b',
  },
  panelHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  panelTitle: {
    fontSize: 15,
    fontWeight: 'bold',
    color: '#f8fafc',
  },
  closePanelText: {
    color: '#60a5fa',
    fontWeight: 'bold',
    fontSize: 13,
  },
  panelSubHeader: {
    fontSize: 13,
    fontWeight: '600',
    color: '#94a3b8',
    marginBottom: 8,
    marginTop: 4,
  },
  commandGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
  },
  gridButton: {
    width: '48%',
    padding: 12,
    borderRadius: 8,
    alignItems: 'center',
    marginBottom: 10,
  },
  cardHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  statusIndicatorContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 6,
  },
  deleteButton: {
    padding: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerActionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  actionButton: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  deleteButtonOutline: {
    borderColor: 'rgba(239, 68, 68, 0.3)',
    backgroundColor: 'rgba(239, 68, 68, 0.1)',
  },
  deleteButtonText: {
    color: '#f87171',
    fontWeight: '600',
    fontSize: 11,
  },
  logoutButtonOutline: {
    borderColor: 'rgba(59, 130, 246, 0.3)',
    backgroundColor: 'rgba(59, 130, 246, 0.1)',
  },
  logoutButtonText: {
    color: '#60a5fa',
    fontWeight: '600',
    fontSize: 11,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  onlineStatusText: {
    fontSize: 12,
    fontWeight: '600',
  },
  telemetryContainer: {
    marginBottom: 12,
  },
  telemetryGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  telemetryCard: {
    backgroundColor: '#1a2234',
    borderWidth: 1,
    borderColor: '#1e293b',
    borderRadius: 8,
    padding: 10,
    width: '48%',
    alignItems: 'center',
  },
  telemetryKey: {
    fontSize: 10,
    color: '#64748b',
    marginBottom: 4,
    fontWeight: '600',
  },
  telemetryValue: {
    fontSize: 15,
    fontWeight: 'bold',
    color: '#38bdf8',
  },
  telemetryPlaceholder: {
    color: '#64748b',
    fontStyle: 'italic',
    textAlign: 'center',
    padding: 8,
    fontSize: 13,
  }
});