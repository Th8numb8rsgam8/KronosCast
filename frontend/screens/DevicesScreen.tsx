import { useState, useEffect, useRef } from 'react';
import {
  Text,
  View,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ActivityIndicator,
  FlatList,
  Modal,
  ListRenderItem
} from 'react-native';
import mqtt, { MqttClient, IClientOptions } from 'mqtt';
import AddDeviceBLEModal from './AddDeviceBLEModal';
import { AuthState, MqttCredentials } from '../types/auth.types';
import { DeviceItem, DeviceCommand } from '../types/device.types';
import { ENV } from '../config/env';

const AVAILABLE_COMMANDS: DeviceCommand[] = [
  { label: 'StreamSwitch On', actionValue: 'STREAMSWITCH_ON', buttonColor: '#007AFF' },
  { label: 'StreamSwitch Off', actionValue: 'STREAMSWITCH_OFF', buttonColor: '#d9534f' },
  { label: 'Reboot Device', actionValue: 'REBOOT', buttonColor: '#f0ad4e' },
  // { label: 'Calibrate Sensor', actionValue: 'CALIBRATE', buttonColor: '#5cb85c' },
];

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

export interface DeviceDashboardProps {
  authState: AuthState;
  onLogout: () => void;
}

export default function DevicesScreen({ authState, onLogout }: DeviceDashboardProps) {
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
      const response = await fetch(`${ENV.BACKEND_PROTOCOL}://${ENV.BACKEND_IP}:${ENV.BACKEND_PORT}/api/devices/${user.id}`);
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
              const response = await fetch(`${ENV.BACKEND_PROTOCOL}://${ENV.BACKEND_IP}:${ENV.BACKEND_PORT}/api/devices/${user.id}/${deviceId}`, {
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
              const response = await fetch(`${ENV.BACKEND_PROTOCOL}://${ENV.BACKEND_IP}:${ENV.BACKEND_PORT}/api/users/${user.id}`, {
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
const styles = StyleSheet.create({
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
  cardHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  deviceName: { 
    fontSize: 16, 
    fontWeight: 'bold',
    color: '#f8fafc' 
  },
  statusIndicatorContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 6,
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
  deleteButton: {
    padding: 8,
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
  logoutButtonText: {
    color: '#60a5fa',
    fontWeight: '600',
    fontSize: 11,
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
  emptyText: { 
    textAlign: 'center', 
    color: '#64748b', 
    marginTop: 20,
    fontStyle: 'italic'
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
  telemetryContainer: {
    marginBottom: 12,
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
  buttonText: { 
    color: '#ffffff', 
    fontSize: 16, 
    fontWeight: '600' 
  },
  telemetryPlaceholder: {
    color: '#64748b',
    fontStyle: 'italic',
    textAlign: 'center',
    padding: 8,
    fontSize: 13,
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
  dashboardContainer: { 
    flex: 1, 
    padding: 20, 
    paddingTop: 60, 
    backgroundColor: '#0b0f19' 
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
  logoutButtonOutline: {
    borderColor: 'rgba(59, 130, 246, 0.3)',
    backgroundColor: 'rgba(59, 130, 246, 0.1)',
  },
})