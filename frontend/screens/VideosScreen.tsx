import React, { useState, useEffect } from 'react';
import { View, Text, TouchableOpacity, FlatList, ActivityIndicator, Alert, StyleSheet } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import { AuthState } from '../types/auth.types';
import { ENV } from '../config/env';

export interface VideoItem {
  id: string;
  filename: string;
  size_mb: number;
}

export default function VideosScreen({ authState }: { authState: AuthState }) {
  const [videos, setVideos] = useState<VideoItem[]>([]);
  const [fetching, setFetching] = useState<boolean>(true);
  const [uploadingVideo, setUploadingVideo] = useState<boolean>(false);
  const BACKEND_URL = `http://${ENV.BACKEND_IP ?? 'localhost'}:${ENV.BACKEND_PORT ?? '3000'}`;

  useEffect(() => {
    fetchVideos();
  }, []);

  const fetchVideos = async () => {
    try {
      const response = await fetch(`${BACKEND_URL}/api/videos`, {
        headers: { 'Authorization': `Bearer ${authState.token}` },
      });
      const data = await response.json();
      if (response.ok) setVideos(data.playlist || []);
    } catch (err) {
      console.error('Failed to load videos:', err);
    } finally {
      setFetching(false);
    }
  };

  const handleUploadVideo = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: 'video/mp4',
        copyToCacheDirectory: true,
      });

      if (result.canceled) return;

      const asset = result.assets[0];
      setUploadingVideo(true);

      const formData = new FormData();
      formData.append('video', {
        uri: asset.uri,
        name: asset.name || 'uploaded_video.mp4',
        type: 'video/mp4',
      } as any);

      const response = await fetch(`${BACKEND_URL}/api/videos/upload`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${authState.token}` },
        body: formData,
      });

      if (response.ok) {
        Alert.alert('Success', 'Video uploaded to bucket successfully!');
        fetchVideos();
      } else {
        const data = await response.json();
        Alert.alert('Upload Failed', data.error || 'Could not upload video.');
      }
    } catch (err) {
      Alert.alert('Error', 'Network error during video upload.');
    } finally {
      setUploadingVideo(false);
    }
  };

  return (
    <View style={styles.screenContainer}>
      <Text style={styles.screenTitle}>Cloud Video Bucket</Text>
      
      <TouchableOpacity 
        style={[styles.addButton, { backgroundColor: '#2563eb' }]} 
        onPress={handleUploadVideo}
        disabled={uploadingVideo}
      >
        {uploadingVideo ? <ActivityIndicator color="#fff" /> : <Text style={styles.addButtonText}>+ Upload MP4 Video</Text>}
      </TouchableOpacity>

      {fetching ? (
        <ActivityIndicator color="#3b82f6" style={{ marginTop: 20 }} />
      ) : (
        <FlatList
          data={videos}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>{item.filename}</Text>
              <Text style={styles.cardSubtitle}>{item.size_mb} MB</Text>
            </View>
          )}
          ListEmptyComponent={<Text style={styles.emptyText}>No videos found in bucket.</Text>}
          contentContainerStyle={{ paddingBottom: 40 }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screenContainer: {
    flex: 1,
    backgroundColor: '#0f172a', // Matches your deep dark theme
    paddingHorizontal: 20,
    paddingTop: 60,
  },
  screenTitle: {
    fontSize: 28,
    fontWeight: '700',
    color: '#38bdf8', // Bright accent blue
    marginBottom: 20,
    textShadowColor: 'rgba(56, 189, 248, 0.6)', // Glowing neon shadow
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 10,
  },
  addButton: { padding: 15, borderRadius: 10, alignItems: 'center', marginBottom: 20 },
  addButtonText: { color: '#ffffff', fontSize: 15, fontWeight: 'bold' },
  card: { backgroundColor: '#121826', padding: 16, borderRadius: 12, marginBottom: 12, borderWidth: 1, borderColor: '#1e293b', flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  cardTitle: { fontSize: 15, fontWeight: 'bold', color: '#f8fafc' },
  cardSubtitle: { color: '#64748b', fontSize: 12 },
  emptyText: { textAlign: 'center', color: '#64748b', marginTop: 20, fontStyle: 'italic' }
});