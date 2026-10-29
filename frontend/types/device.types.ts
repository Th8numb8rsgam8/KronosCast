export interface DeviceItem {
  id: string;
  device_name: string;
}

export interface DeviceCommand {
  label: string;
  actionValue: string;
  buttonColor?: string;
}