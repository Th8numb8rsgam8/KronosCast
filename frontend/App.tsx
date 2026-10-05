import React, { useState, useEffect } from 'react';
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

export interface MqttCredentials {
  brokerUrl: string;
  username: string;
  password: string;
  topics: {
    telemetrySbuscribe: string;
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
  mqtt_topic: string;
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

export default function App(): React.ReactElement {
  const [authState, setAuthState] = useState<AuthState | null>(null);

  if (!authState) {
    return <AuthScreen onAuthSuccess={(data: AuthState) => setAuthState(data)} />;
  }

  return <DeviceDashboard authState={authState} onLogout={() => setAuthState(null)} />;
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
      <Text style={styles.title}>{isLoginMode ? 'IoT User Login' : 'IoT User Registration'}</Text>

      <View style={styles.form}>
        {!isLoginMode && (<TextInput
          style={styles.input}
          placeholder="Username"
          placeholderTextColor="#888"
          value={username}
          onChangeText={setUsername}
          autoCapitalize="none"
          editable={!loading}
        />
        )}
        <TextInput
          style={styles.input}
          placeholder="Email Address"
          placeholderTextColor="#888"
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          keyboardType="email-address"
          editable={!loading}
        />
        <TextInput
          style={styles.input}
          placeholder="Password"
          placeholderTextColor="#888"
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
  const { user, mqtt } = authState;
  const [devices, setDevices] = useState<DeviceItem[]>([]);
  const [fetching, setFetching] = useState<boolean>(true);
  const [modalVisible, setModalVisible] = useState<boolean>(false);

  useEffect(() => {
    fetchDevices();

    // ------------------------------------------------------------------------
    // TODO: Connect React Native MQTT client using `mqtt` credentials here
    // e.g., const client = initMqttClient(mqtt);
    // ------------------------------------------------------------------------
  }, []);

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

  const renderDeviceItem: ListRenderItem<DeviceItem> = ({ item }) => (
    <View style={styles.deviceCard}>
      <Text style={styles.deviceName}>{item.device_name}</Text>
      <Text style={styles.deviceTopic}>Topic: {item.mqtt_topic}</Text>
    </View>
  );

  return (
    <View style={styles.dashboardContainer}>
      <View style={styles.headerRow}>
        <Text style={styles.welcomeText}>Hello, {user.username}</Text>
        <TouchableOpacity onPress={onLogout}>
          <Text style={styles.logoutText}>Logout</Text>
        </TouchableOpacity>
      </View>

      <TouchableOpacity style={styles.addButton} onPress={() => setModalVisible(true)}>
        <Text style={styles.addButtonText}>+ Add Edge Device (BLE)</Text>
      </TouchableOpacity>

      <Text style={styles.sectionTitle}>Your Devices</Text>

      {fetching ? (
        <ActivityIndicator color="#007AFF" style={{ marginTop: 20 }} />
      ) : (
        <FlatList
          data={devices}
          keyExtractor={(item: DeviceItem) => item.id}
          renderItem={renderDeviceItem}
          ListEmptyComponent={<Text style={styles.emptyText}>No devices added yet.</Text>}
        />
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
      Alert.alert('Permission Denied', 'Bluetooth and Location permissions are required to pair edge devices.');
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

                    const errorMsg = charError.message || '';
                    const errorCode = charError.errorCode;

                    if (
                      errorCode === 2 ||
                      errorCode === 201 ||
                      errorMsg.toLowerCase().includes('cancel') ||
                      errorMsg.toLowerCase().includes('disconnect')
                    ) {
                      // console.log('[BLE] Cleanly suppressed cancellation/teardown error:', errorMsg);
                      return;
                    }

                    console.error('[BLE Subscription Error]:', charError);
                    return;
                  }

                  if (characteristic?.value) {
                    const liveStatus = Buffer.from(characteristic.value, 'base64').toString('utf-8');
                    console.log('[BLE Live Status]:', liveStatus);
                    setStatusText(`Device Status: ${liveStatus}`);

                    if (liveStatus === 'SUCCESS') {
                      sessionState.isFinished = true

                      if (statusSubscription){
                        statusSubscription.remove();
                        statusSubscription = null
                      }
                      setLoading(false);
                      Alert.alert('Success', 'Edge device provisioned and connected successfully!');
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
              const totalChunks = Math.ceil(jwtToken.length / chunkSize);
              for (let i = 0; i < jwtToken.length; i += chunkSize) {
                const currentChunkNumber = Math.floor(i / chunkSize) + 1;
                const chunk = jwtToken.slice(i, i + chunkSize);
                const chunkBase64 = Buffer.from(chunk, 'utf-8').toString('base64');

                console.log(`[BLE] Writing JWT chunk ${currentChunkNumber}/${totalChunks}...`);

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
                  Alert.alert(
                    'Timeout',
                    'Hardware did not respond in time. Please check Wi-Fi credentials.');
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
      <Text style={styles.title}>Provision Edge Device</Text>

      <TextInput
        style={styles.input}
        placeholder="Device Name (e.g., Living Room Thermostat)"
        placeholderTextColor="#888"
        value={deviceName}
        onChangeText={setDeviceName}
        editable={!loading}
      />
      <TextInput
        style={styles.input}
        placeholder="Wi-Fi SSID"
        placeholderTextColor="#888"
        value={wifiSsid}
        onChangeText={setWifiSsid}
        autoCapitalize="none"
        editable={!loading}
      />
      <TextInput
        style={styles.input}
        placeholder="Wi-Fi Password"
        placeholderTextColor="#888"
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
      >
        {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Pair & Transmit over BLE</Text>}
      </TouchableOpacity>

      <TouchableOpacity style={styles.cancelButton} onPress={onClose} disabled={loading}>
        <Text style={styles.cancelButtonText}>Cancel</Text>
      </TouchableOpacity>
    </View>
  );
}

// ----------------------------------------------------------------------------
// STYLES
// ----------------------------------------------------------------------------
const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', padding: 20, backgroundColor: '#f5f5f5' },
  dashboardContainer: { flex: 1, padding: 20, paddingTop: 60, backgroundColor: '#f5f5f5' },
  modalContainer: { flex: 1, justifyContent: 'center', padding: 20, backgroundColor: '#fff' },
  title: { fontSize: 22, fontWeight: 'bold', textAlign: 'center', marginBottom: 20 },
  form: { backgroundColor: '#fff', padding: 20, borderRadius: 10, elevation: 2 },
  input: { 
    color: '#000000', 
    borderWidth: 1, 
    borderColor: '#ccc', 
    borderRadius: 6, 
    padding: 12, 
    marginBottom: 15, 
    fontSize: 16, 
    backgroundColor: '#fff',
    fontFamily: Platform.OS === 'android' ? 'normal': undefined
  },
  button: { backgroundColor: '#007AFF', padding: 15, borderRadius: 6, alignItems: 'center' },
  disabledButton: { backgroundColor: '#a0c4ff' },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: 'bold' },
  toggleButton: { marginTop: 15, alignItems: 'center' },
  toggleButtonText: { color: '#007AFF', fontSize: 14, fontWeight: '600' },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 },
  welcomeText: { fontSize: 20, fontWeight: 'bold' },
  logoutText: { color: '#d9534f', fontWeight: 'bold' },
  addButton: { backgroundColor: '#34c759', padding: 15, borderRadius: 6, alignItems: 'center', marginBottom: 20 },
  addButtonText: { color: '#fff', fontSize: 16, fontWeight: 'bold' },
  sectionTitle: { fontSize: 18, fontWeight: 'bold', marginBottom: 10 },
  deviceCard: { backgroundColor: '#fff', padding: 15, borderRadius: 8, marginBottom: 10, borderWidth: 1, borderColor: '#e0e0e0' },
  deviceName: { fontSize: 16, fontWeight: 'bold' },
  deviceTopic: { fontSize: 14, color: '#666', marginTop: 4 },
  emptyText: { textAlign: 'center', color: '#888', marginTop: 20 },
  statusText: { color: '#007AFF', textAlign: 'center', marginVertical: 10, fontStyle: 'italic' },
  cancelButton: { marginTop: 15, alignItems: 'center' },
  cancelButtonText: { color: '#888', fontSize: 16 },
});