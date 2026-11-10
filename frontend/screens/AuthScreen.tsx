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
import { join } from 'node:path';

interface AuthScreenProps {
  onAuthSuccess: (authData: AuthState) => void;
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const STRONG_PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!\%*?&]{8,}$/;

type ScreenMode = 'login' | 'signup' | 'verify-otp' | 'forgot-password' | 'forgot-password' | 'reset-password';

export default function AuthScreen({ onAuthSuccess }: AuthScreenProps): React.ReactElement {
  const [screenMode, setScreenMode] = useState<ScreenMode>('login');
  const [pendingVerificationEmail, setPendingVerificationEmail] = useState<string | null>(null);
  const [failedLoginAttempts, setFailedLoginAttempts] = useState<number>(0);

  const [username, setUsername] = useState<string>('');
  const [email, setEmail] = useState<string>('');
  const [password, setPassword] = useState<string>('');
  const [newPassword, setNewPassword] = useState<string>('');
  const [otpCode, setOtpCode] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(false);

  const switchMode = (mode: ScreenMode) => {
    setScreenMode(mode);
    if (mode === 'login') {
      setUsername('');
      setPassword('');
      setNewPassword('');
      setOtpCode('');
    }
  };

  const handleAuthSubmit = async (): Promise<void> => {
    if (!email || !password) {
      Alert.alert('Error', 'Please fill in all fields.');
      return;
    }

    const isLoginMode = screenMode === 'login';

    if (!isLoginMode){
      if (!username.trim()) {
        Alert.alert('Validation Error', 'Username is required for registration.');
        return;
      }

      if (!EMAIL_REGEX.test(email)) {
        Alert.alert('Validation Error', 'Please enter a valid email address.');
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
    const payload = isLoginMode 
      ? { identifier: email.trim(), password } 
      : { username: username.trim(), email: email.trim(), password };

    try {
      const response = await fetch(`${ENV.BACKEND_PROTOCOL}://${ENV.BACKEND_IP}:${ENV.BACKEND_PORT}${endpoint}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
      });

      const data = await response.json();

      if (response.ok) {
        if (isLoginMode) {
          // Successful login resets counter
          setFailedLoginAttempts(0);
        }

        if (!isLoginMode || data.requiresVerification) {
          setPendingVerificationEmail(email);
          Alert.alert('Check Your Email', 'We sent a 6-digit verification code to your inbox.');
        } else {
          // Standard login success
          // Pass full AuthState (user, token, mqtt credentials) to parent
          onAuthSuccess({
            user: data.user,
            access_token: data.access_token,
            refresh_token: data.refresh_token,
            mqtt: data.mqtt,
          });
        }
      } else {
        if (isLoginMode) {
          const nextAttempts = failedLoginAttempts + 1;
          setFailedLoginAttempts(nextAttempts);

          if (nextAttempts >= 3) {
            Alert.alert(
              'Multiple Failed Attempts',
              'You have failed to log in 3 times. Would you like to reset your password?',
              [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Reset Password', onPress: () => setScreenMode('forgot-password') }
              ]
            );
          }
        }

        if (data.requiresVerification) {
          setPendingVerificationEmail(data.email || email);
        }
        Alert.alert('Authentication Failed', data.error || 'Something went wrong');
      }
    } catch (error) {
      Alert.alert('Network Error', 'Could not connect to backend service.');
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyOtp = async (): Promise<void> => {
    if (!otpCode || otpCode.length !== 6) {
      Alert.alert('Error', 'Please enter the full 6-digit verification code.');
      return;
    }

    setLoading(true);
    try {
      const response = await fetch(`${ENV.BACKEND_PROTOCOL}://${ENV.BACKEND_IP}:${ENV.BACKEND_PORT}/api/auth/verify-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: pendingVerificationEmail, otp: otpCode }),
      });

      const data = await response.json();

      if (response.ok) {
        Alert.alert('Success', 'Email verified successfully!');
        onAuthSuccess({
          user: data.user,
          access_token: data.access_token,
          refresh_token: data.refresh_token,
          mqtt: data.mqtt,
        });
      } else {
        Alert.alert('Verification Failed', data.error || 'Invalid OTP');
      }
    } catch (error) {
      Alert.alert('Network Error', 'Could not verify code.');
    } finally {
      setLoading(false);
    }
  };

  const handleResendOtp = async (): Promise<void> => {
    try {
      const response = await fetch(`${ENV.BACKEND_PROTOCOL}://${ENV.BACKEND_IP}:${ENV.BACKEND_PORT}/api/auth/resend-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: pendingVerificationEmail }),
      });
      const data = await response.json();
      if (response.ok) {
        Alert.alert('Code Sent', 'A new verification code has been sent to your email.');
      } else {
        Alert.alert('Error', data.error || 'Failed to resend code.');
      }
    } catch (err) {
      Alert.alert('Network Error', 'Could not resend code.');
    }
  };

  // Request Password Reset OTP
  const handleRequestPasswordReset = async (): Promise<void> => {

    let targetEmail = email.trim();

    // If the field contains a username instead of an email, or is empty:
    if (!targetEmail || !EMAIL_REGEX.test(targetEmail)) {
      /// Alert.prompt
      // Note: Alert.prompt is iOS only. For cross-platform support in React Native, 
      // it's best to switch the screen mode to a dedicated email entry view or use state:
      setScreenMode('forgot-password');
      return;
    }

    setLoading(true);
    try {
      const response = await fetch(`${ENV.BACKEND_PROTOCOL}://${ENV.BACKEND_IP}:${ENV.BACKEND_PORT}/api/auth/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: targetEmail.trim() }),
      });
      const data = await response.json();

      if (response.ok) {
        setEmail(targetEmail); // Ensure email state is set for the next screen
        setScreenMode('reset-password');
        Alert.alert('Recovery Code Sent', 'Check your email for the 6-digit password reset code.');
      } else {
        Alert.alert('Error', data.error || 'Failed to send password reset code.');
      }
    } catch (err) {
      Alert.alert('Network Error', 'Could not connect to backend.');
    } finally {
      setLoading(false);
    }
  };

  // Submit New Password with OTP
  const handleConfirmPasswordReset = async (): Promise<void> => {
    if (!otpCode || otpCode.length !== 6 || !newPassword) {
      Alert.alert('Error', 'Please enter the 6-digit code and your new password.');
      return;
    }

    if (!STRONG_PASSWORD_REGEX.test(newPassword)) {
      Alert.alert(
        'Validation Error',
        'Password must be 8+ characters and contain uppercase, lowercase, number, & special character.'
      );
      return;
    }

    setLoading(true);
    try {
      const response = await fetch(`${ENV.BACKEND_PROTOCOL}://${ENV.BACKEND_IP}:${ENV.BACKEND_PORT}/api/auth/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), otp: otpCode, newPassword }),
      });
      const data = await response.json();

      if (response.ok) {
        Alert.alert('Success', 'Password reset successfully! Please log in with your new password.');
        setFailedLoginAttempts(0);
        setPassword('');
        setNewPassword('');
        setOtpCode('');
        setScreenMode('login');
      } else {
        Alert.alert('Reset Failed', data.error || 'Invalid code or expired token.');
      }
    } catch (err) {
      Alert.alert('Network Error', 'Could not reset password.');
    } finally {
      setLoading(false);
    }
  };

  if (screenMode === 'forgot-password') {
    return (
      <View style={styles.container}>
        <Text style={styles.brandTitle}>KRONOS</Text>
        <Text style={styles.title}>Password Recovery</Text>
        <Text style={styles.subtitle}>Enter your account email to receive a reset code.</Text>

        <View style={styles.form}>
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
          <TouchableOpacity style={styles.button} onPress={handleRequestPasswordReset} disabled={loading}>
            {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Send Reset Code</Text>}
          </TouchableOpacity>
          <TouchableOpacity style={[styles.toggleButton, { marginTop: 10 }]} onPress={() => switchMode('login')}>
            <Text style={[styles.toggleButtonText, { color: '#94a3b8' }]}>Back to Login</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // OTP Verification Screen (Signup)
  if (screenMode === 'verify-otp') {
    return (
      <View style={styles.container}>
        <Text style={styles.brandTitle}>KRONOS</Text>
        <Text style={styles.title}>Verify Your Email</Text>
        <Text style={styles.subtitle}>Enter the 6-digit code sent to {pendingVerificationEmail}</Text>

        <View style={styles.form}>
          <TextInput
            style={[styles.input, { textAlign: 'center', fontSize: 22, letterSpacing: 6 }]}
            placeholder="123456"
            placeholderTextColor="#64748b"
            value={otpCode}
            onChangeText={setOtpCode}
            keyboardType="number-pad"
            maxLength={6}
            editable={!loading}
          />
          <TouchableOpacity style={styles.button} onPress={handleVerifyOtp} disabled={loading}>
            {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Verify Code</Text>}
          </TouchableOpacity>
          <TouchableOpacity style={styles.toggleButton} onPress={handleResendOtp} disabled={loading}>
            <Text style={styles.toggleButtonText}>Didn't receive a code? Resend</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.toggleButton, { marginTop: 10 }]} onPress={() => switchMode('login')}>
            <Text style={[styles.toggleButtonText, { color: '#94a3b8' }]}>Back to Login</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // Password Reset Screen (Enter OTP + New Password)
  if (screenMode === 'reset-password') {
    return (
      <View style={styles.container}>
        <Text style={styles.brandTitle}>KRONOS</Text>
        <Text style={styles.title}>Reset Password</Text>
        <Text style={styles.subtitle}>Enter the 6-digit code sent to {email} and your new password.</Text>

        <View style={styles.form}>
          <TextInput
            style={[styles.input, { textAlign: 'center', fontSize: 22, letterSpacing: 6 }]}
            placeholder="123456"
            placeholderTextColor="#64748b"
            value={otpCode}
            onChangeText={setOtpCode}
            keyboardType="number-pad"
            maxLength={6}
            editable={!loading}
          />
          <TextInput
            style={styles.input}
            placeholder="New Password"
            placeholderTextColor="#64748b"
            value={newPassword}
            onChangeText={setNewPassword}
            secureTextEntry
            editable={!loading}
          />
          <TouchableOpacity style={styles.button} onPress={handleConfirmPasswordReset} disabled={loading}>
            {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Update Password</Text>}
          </TouchableOpacity>
          <TouchableOpacity style={[styles.toggleButton, { marginTop: 10 }]} onPress={() => switchMode('login')}>
            <Text style={[styles.toggleButtonText, { color: '#94a3b8' }]}>Cancel / Back to Login</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // Standard Login / Sign Up Screen
  const isLoginMode = screenMode === 'login';

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
          placeholder={isLoginMode ? "Username or Email" : "Email Address"}
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

        {/* Show Forgot Password button if attempts >= 3 or manual user click */}
        {isLoginMode && failedLoginAttempts > 0 && (
          <TouchableOpacity style={styles.forgotPasswordButton} onPress={handleRequestPasswordReset} disabled={loading}>
            <Text style={styles.forgotPasswordText}>
              {failedLoginAttempts >= 3 ? 'Forgot password? Click here to reset' : 'Forgot Password?'}
            </Text>
          </TouchableOpacity>
        )}

        <TouchableOpacity style={styles.toggleButton} onPress={() => switchMode(isLoginMode ? 'signup' : 'login')} disabled={loading}>
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
  forgotPasswordButton: {
    marginTop: 12,
    alignItems: 'center',
  },
  forgotPasswordText: {
    color: '#ef4444', // Red warning color to highlight recovery after failed attempts
    fontSize: 13,
    fontWeight: '500',
  },
});