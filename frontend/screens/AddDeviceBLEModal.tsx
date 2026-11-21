import { useEffect, useRef, useState } from 'react';
import { User } from '../types/auth.types'
import {
  Text,
  View,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ActivityIndicator,
  Platform,
  PermissionsAndroid,
} from 'react-native';
import { BleManager, Device, Subscription, BleError } from 'react-native-ble-plx';
import { Buffer } from 'buffer';
import { apiClient } from '../api/interceptor';
import { ENV } from '../config/env';

interface AddDeviceBLEModalProps {
  user: User;
  onClose: () => void;
  onSuccess: () => void;
}

interface ActiveProvisionSession {
  cancelled: boolean;
  finished: boolean;
  subscription: Subscription | null;
  connectedDevice: Device | null;
  timeoutId: ReturnType<typeof setTimeout> | null;
}

const bleManager = new BleManager();

export default function AddDeviceBLEModal({ user, onClose, onSuccess }: AddDeviceBLEModalProps) {
  const [deviceName, setDeviceName] = useState<string>('');
  const [wifiSsid, setWifiSsid] = useState<string>('');
  const [wifiPassword, setWifiPassword] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(false);
  const [statusText, setStatusText] = useState<string>('');

  const sessionRef = useRef<ActiveProvisionSession | null>(null);

  const cleanupSession = async (session: ActiveProvisionSession | null): Promise<void> => {
    if (!session) return;

    bleManager.stopDeviceScan();

    if (session.timeoutId) {
      clearTimeout(session.timeoutId);
      session.timeoutId = null;
    }

    if (session.subscription) {
      session.subscription.remove();
      session.subscription = null;
    }

    if (session.connectedDevice) {
      const deviceId = session.connectedDevice.id;
      session.connectedDevice = null;
      try {
        const isConnected = await bleManager.isDeviceConnected(deviceId);
        if (isConnected) {
          await bleManager.cancelDeviceConnection(deviceId);
        }
      } catch {
        // Ignore teardown errors when cancelling or disconnecting
      }
    }
  };

  const handleCancel = async (): Promise<void> => {
    const active = sessionRef.current;

    if (!loading || !active) {
      onClose();
      return;
    }

    active.cancelled = true;
    active.finished = true;
    sessionRef.current = null;

    setLoading(false);
    setStatusText('');

    await cleanupSession(active);
    onClose();
  };

  useEffect(() => {
    return () => {
      const active = sessionRef.current;
      if (active) {
        active.cancelled = true;
        active.finished = true;
        sessionRef.current = null;
        void cleanupSession(active);
      }
    };
  }, []);

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

    // Tear down any lingering previous session before starting a new one
    if (sessionRef.current) {
      const stale = sessionRef.current;
      stale.cancelled = true;
      stale.finished = true;
      sessionRef.current = null;
      await cleanupSession(stale);
    }

    // Fresh session for this specific onboarding run
    const session: ActiveProvisionSession = {
      cancelled: false,
      finished: false,
      subscription: null,
      connectedDevice: null,
      timeoutId: null,
    };
    sessionRef.current = session;

    setLoading(true);

    try {
      // Step 1: Request signed JWT setup token from Express
      setStatusText('Generating JWT setup token...');
      const response = await apiClient.post('/api/auth/devices/request-setup', { deviceName });

      if (session.cancelled || session.finished || sessionRef.current !== session) {
        return;
      }

      const jwtToken = response.data.setupToken; // Signed JWT token
      let isProcessingDevice = false;

      // Step 2: Scan for BLE Hardware
      setStatusText('Scanning for BLE hardware...');
      bleManager.startDeviceScan(
        [ENV.SERVICE_UUID], 
        null, 
        async (error: BleError | null, device: Device | null) => {
          if (session.cancelled || session.finished || sessionRef.current !== session) {
            return;
          }

          if (error) {
            session.finished = true;
            if (sessionRef.current === session) {
              sessionRef.current = null;
            }
            await cleanupSession(session);
            setLoading(false);
            Alert.alert('BLE Error', error.message);
            return;
          }

          if (device && !isProcessingDevice) {
            isProcessingDevice = true;
            bleManager.stopDeviceScan();

            try {
              setStatusText('Connecting via BLE...');

              const connectedDevice = await device.connect();
              if (session.cancelled || session.finished || sessionRef.current !== session) {
                try {
                  await bleManager.cancelDeviceConnection(connectedDevice.id);
                } catch {
                  // Ignore disconnect errors after cancel
                }
                return;
              }

              session.connectedDevice = connectedDevice;
              await connectedDevice.discoverAllServicesAndCharacteristics();

              // Listen for status updates
              session.subscription = bleManager.monitorCharacteristicForDevice(
                connectedDevice.id,
                ENV.SERVICE_UUID,
                ENV.STATUS_CHARACTERISTIC_UUID,
                (charError: BleError | null, characteristic) => {
                  if (charError) {
                    if (session.cancelled || session.finished) return;
                    return;
                  }

                  if (characteristic?.value) {
                    if (session.cancelled || session.finished) return;

                    const liveStatus = Buffer.from(characteristic.value, 'base64').toString('utf-8');
                    setStatusText(`Device Status: ${liveStatus}`);

                    if (liveStatus === 'SUCCESS') {
                      session.finished = true
                      if (sessionRef.current === session) {
                        sessionRef.current = null;
                      }
                      void cleanupSession(session);
                      setLoading(false);
                      Alert.alert('Success', 'Edge device provisioned successfully!');
                      onSuccess();
                    } else if (liveStatus.startsWith('ERROR_')) {
                      session.finished = true;
                      if (sessionRef.current === session) {
                        sessionRef.current = null;
                      }
                      void cleanupSession(session);
                      setLoading(false);
                      Alert.alert('Provisioning Error', `Hardware reported error: ${liveStatus}`);
                    }
                  }
                }
              )
              await new Promise((resolve) => setTimeout(resolve, 300));

              // Transmit Wi-Fi Credentials + JWT Payload
              const ssidBase64 = Buffer.from(wifiSsid).toString('base64');
              await connectedDevice.writeCharacteristicWithResponseForService(
                ENV.SERVICE_UUID,
                ENV.SSID_CHARACTERISTIC_UUID,
                ssidBase64
              );
              if (session.cancelled || session.finished || sessionRef.current !== session) return;

              const passBase64 = Buffer.from(wifiPassword).toString('base64');
              await connectedDevice.writeCharacteristicWithResponseForService(
                ENV.SERVICE_UUID,
                ENV.PASS_CHARACTERISTIC_UUID,
                passBase64
              );
              if (session.cancelled || session.finished || sessionRef.current !== session) return;

              const negotiatedDevice = await connectedDevice.requestMTU(512);
              const chunkSize = negotiatedDevice.mtu;
              // const totalChunks = Math.ceil(jwtToken.length / chunkSize);
              for (let i = 0; i < jwtToken.length; i += chunkSize) {
                const currentChunkNumber = Math.floor(i / chunkSize) + 1;
                const chunk = jwtToken.slice(i, i + chunkSize);
                const chunkBase64 = Buffer.from(chunk, 'utf-8').toString('base64');

                // console.log(`[BLE] Writing JWT chunk ${currentChunkNumber}/${totalChunks}...`);

                await connectedDevice.writeCharacteristicWithResponseForService(
                  ENV.SERVICE_UUID,
                  ENV.JWT_CHARACTERISTIC_UUID,
                  chunkBase64
                );
              }
              if (session.cancelled || session.finished || sessionRef.current !== session) return;

              // Send __EOF__ marker to signal transmission completion
              const eofBase64 = Buffer.from('__EOF__', 'utf-8').toString('base64');
              await connectedDevice.writeCharacteristicWithResponseForService(
                ENV.SERVICE_UUID,
                ENV.JWT_CHARACTERISTIC_UUID,
                eofBase64
              );

              if (session.cancelled || session.finished || sessionRef.current !== session) return;
              setStatusText('Waiting for hardware to connect to Wi-Fi...');

              // Fail-safe timeout in case physical BLE notification gets dropped
              session.timeoutId = setTimeout(() => {
                if (!session.cancelled && !session.finished && sessionRef.current === session) {
                  session.finished = true;
                  sessionRef.current = null;
                  void cleanupSession(session);
                  setLoading(false);
                  Alert.alert('Timeout', 'Hardware did not respond in time.');
                  }
                }, 35000);
            } catch (innerErr: unknown) {
              if (!session.cancelled && !session.finished && sessionRef.current === session){
                session.finished = true;
                sessionRef.current = null;
                await cleanupSession(session);
                setLoading(false);
                const errorMessage = innerErr instanceof Error ? innerErr.message : 'Unknown provisioning error';
                Alert.alert('Provisioning Error', errorMessage);
              }
            }
          }
        }
      );
    } catch (err: unknown) {
      if (session.cancelled || session.finished || sessionRef.current !== session) {
        return;
      }
      session.finished = true;
      sessionRef.current = null;
      await cleanupSession(session);
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

        <TouchableOpacity 
          style={styles.cancelButton} 
          onPress={handleCancel} 
          activeOpacity={0.7}>
          <Text style={styles.cancelButtonText}>
            {loading ? 'Cancel Provisioning' : 'Cancel'}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
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
  statusText: { 
    color: '#60a5fa', 
    textAlign: 'center', 
    marginVertical: 12, 
    fontStyle: 'italic',
    fontSize: 13,
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
  cancelButton: { 
    marginTop: 16, 
    alignItems: 'center' 
  },
  cancelButtonText: { 
    color: '#94a3b8', 
    fontSize: 15,
    fontWeight: '500' 
  },
})