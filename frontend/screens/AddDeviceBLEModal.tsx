import { useState } from 'react';
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
import { SessionState } from '../types/auth.types';
import { ENV } from '../config/env';

interface AddDeviceBLEModalProps {
  user: User;
  onClose: () => void;
  onSuccess: () => void;
}

const bleManager = new BleManager();

export default function AddDeviceBLEModal({ user, onClose, onSuccess }: AddDeviceBLEModalProps) {
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
      const response = await fetch(`${ENV.BACKEND_PROTOCOL}://${ENV.BACKEND_IP}:${ENV.BACKEND_PORT}/api/devices/request-setup`, {
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
        [ENV.SERVICE_UUID], 
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
                ENV.SERVICE_UUID,
                ENV.STATUS_CHARACTERISTIC_UUID,
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
                ENV.SERVICE_UUID,
                ENV.SSID_CHARACTERISTIC_UUID,
                ssidBase64
              );

              // setStatusText('Sending Password...');
              const passBase64 = Buffer.from(wifiPassword).toString('base64');
              await connectedDevice.writeCharacteristicWithResponseForService(
                ENV.SERVICE_UUID,
                ENV.PASS_CHARACTERISTIC_UUID,
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
                  ENV.SERVICE_UUID,
                  ENV.JWT_CHARACTERISTIC_UUID,
                  chunkBase64
                );
              }

              // 2. Send __EOF__ marker to signal transmission completion
              // console.log('Finalizing Token...');
              const eofBase64 = Buffer.from('__EOF__', 'utf-8').toString('base64');
              await connectedDevice.writeCharacteristicWithResponseForService(
                ENV.SERVICE_UUID,
                ENV.JWT_CHARACTERISTIC_UUID,
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