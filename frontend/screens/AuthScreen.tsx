import React, { useState } from 'react';
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
import { AuthState } from '../types/auth.types';
import { ENV } from '../config/env';

interface AuthScreenProps {
  onAuthSuccess: (authData: AuthState) => void;
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const STRONG_PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!\%*?&]{8,}$/;

export default function AuthScreen({ onAuthSuccess }: AuthScreenProps): React.ReactElement {
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
        
        const response = await fetch(`${ENV.BACKEND_PROTOCOL}://${ENV.BACKEND_IP}:${ENV.BACKEND_PORT}${endpoint}`, {
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
});