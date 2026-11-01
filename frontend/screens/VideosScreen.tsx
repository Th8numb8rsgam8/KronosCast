import { useState, useEffect } from 'react';
import { 
  View, 
  Text, 
  TouchableOpacity, 
  FlatList, 
  ActivityIndicator, 
  Alert, 
  StyleSheet,
  TextInput,
  Modal 
} from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import { AuthState } from '../types/auth.types';
import { apiClient } from '../api/interceptor';
import { VideoItem } from '../types/video.types';

// export interface VideoItem {
//   id: string;
//   filename: string;
//   size: number;
// }

export default function VideosScreen({ authState }: { authState: AuthState }) {
  const [videos, setVideos] = useState<VideoItem[]>([]);
  const [fetching, setFetching] = useState<boolean>(true);
  const [uploadingVideo, setUploadingVideo] = useState<boolean>(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // New state for handling custom video naming prompt/modal
  const [modalVisible, setModalVisible] = useState<boolean>(false);
  const [selectedAsset, setSelectedAsset] = useState<DocumentPicker.DocumentPickerAsset | null>(null);
  const [customVideoName, setCustomVideoName] = useState<string>('');

  useEffect(() => {
    fetchVideos();
  }, []);

  const fetchVideos = async () => {
    try {
      const response = await apiClient.get(`/api/videos`);
      setVideos(response.data.videos || []);
    } catch (err) {
      console.error('Failed to load videos:', err);
    } finally {
      setFetching(false);
    }
  };

  // Step 1: Open document picker and cache selected asset
  const handlePickDocument = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: 'video/mp4',
        copyToCacheDirectory: true,
      });

      if (result.canceled) return;

      const asset = result.assets[0];

      // 🛡️ Manual safety check for file type
      const isMp4 = 
        (asset.name && asset.name.toLowerCase().endsWith('.mp4')) || 
        asset.mimeType === 'video/mp4';

      if (!isMp4) {
        Alert.alert('Invalid File Type', 'Please select a valid .mp4 video file.');
        return;
      }

      setSelectedAsset(asset);
      // Pre-fill input with original filename (stripping extension optionally, or keeping it)
      setCustomVideoName(asset.name || '');
      setModalVisible(true);
    } catch (err) {
      Alert.alert('Error', 'Failed to pick document.');
    }
  };

  // Step 2: Validate uniqueness on frontend and dispatch upload request
  const handleConfirmUpload = async () => {
    if (!selectedAsset || !customVideoName.trim()) {
      Alert.alert('Error', 'Please provide a valid video name.');
      return;
    }

    const trimmedName = customVideoName.trim();
    // Ensure it ends with .mp4 for consistency
    const finalFilename = trimmedName.endsWith('.mp4') ? trimmedName : `${trimmedName}.mp4`;

    // 🔍 Frontend Uniqueness Check against existing videos list
    const nameExists = videos.some(
      (v) => v.filename.toLowerCase() === finalFilename.toLowerCase()
    );

    if (nameExists) {
      Alert.alert('Name Taken', 'A video with this filename already exists in your bucket. Please choose a different name.');
      return;
    }

    setModalVisible(false);
    setUploadingVideo(true);

    try {
      const formData = new FormData();

      formData.append('name', finalFilename);
      formData.append('video', {
        uri: selectedAsset.uri,
        name: finalFilename, // 🏷️ Custom name passed to backend
        type: 'video/mp4',
      } as any);

      await apiClient.post(`/api/videos/upload`, formData, {
        timeout: 300000, // 5 minutes specifically for a heavy MP4 upload
        headers: {
          'Content-Type': 'multipart/form-data'
        },
      });
      Alert.alert('Success', 'Video uploaded to bucket successfully!');
      fetchVideos();
    } catch (err: any) {
      const serverMessage = err.response?.data?.message || err.response?.data?.error || 'Network error during video upload.';
      Alert.alert('Error', serverMessage);
    } finally {
      setUploadingVideo(false);
      setSelectedAsset(null);
      setCustomVideoName('');
    }
  };

  // 🗑️ Handle Delete Video Action
  const handleDeleteVideo = (video: VideoItem) => {
    Alert.alert(
      'Delete Video',
      `Are you sure you want to delete "${video.filename}"?`,
      [
        { text: 'Cancel', style: 'cancel' },
        { 
          text: 'Delete', 
          style: 'destructive', 
          onPress: async () => {
            try {
              setDeletingId(video.id);
              await apiClient.delete(`/api/videos/`, {
                data: { s3Key: video.id }
              });
              Alert.alert('Success', 'Video deleted successfully.');
              fetchVideos(); // Refresh list
            } catch (err: any) {
              const serverMessage = err.response?.data?.message || err.response?.data?.error || 'Failed to delete video.';
              Alert.alert('Error', serverMessage);
            } finally {
              setDeletingId(null);
            }
          } 
        }
      ]
    );
  };

  return (
    <View style={styles.screenContainer}>
      <Text style={styles.screenTitle}>Cloud Video Bucket</Text>
      
      <TouchableOpacity 
        style={[styles.addButton, { backgroundColor: '#2563eb' }]} 
        onPress={handlePickDocument}
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
              <View style={styles.cardInfo}>
                <Text style={styles.cardTitle}>{item.filename}</Text>
                <Text style={styles.cardSubtitle}>{item.size} MB</Text>
              </View>

              <TouchableOpacity 
                style={styles.deleteButton} 
                onPress={() => handleDeleteVideo(item)}
                disabled={deletingId === item.id}
              >
                {deletingId === item.id ? (
                  <ActivityIndicator size="small" color="#ef4444" />
                ) : (
                  <Text style={styles.deleteButtonText}>🗑️</Text>
                )}
              </TouchableOpacity>
            </View>
          )}
          ListEmptyComponent={<Text style={styles.emptyText}>No videos found in your bucket.</Text>}
          contentContainerStyle={{ paddingBottom: 40 }}
        />
      )}

      {/* Custom Name Input Modal */}
      <Modal
        animationType="slide"
        transparent={true}
        visible={modalVisible}
        onRequestClose={() => setModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Name Your Video</Text>
            <Text style={styles.modalSubtitle}>Enter a unique filename for your upload:</Text>
            
            <TextInput
              style={styles.input}
              placeholder="e.g., promotional_ad_v1.mp4"
              placeholderTextColor="#64748b"
              value={customVideoName}
              onChangeText={setCustomVideoName}
              autoCapitalize="none"
              autoCorrect={false}
            />

            <View style={styles.modalButtons}>
              <TouchableOpacity 
                style={[styles.modalButton, styles.cancelButton]} 
                onPress={() => setModalVisible(false)}
              >
                <Text style={styles.cancelButtonText}>Cancel</Text>
              </TouchableOpacity>

              <TouchableOpacity 
                style={[styles.modalButton, styles.confirmButton]} 
                onPress={handleConfirmUpload}
              >
                <Text style={styles.confirmButtonText}>Upload</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
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
    textAlign: 'center',
    alignSelf: 'center',
    textShadowColor: 'rgba(56, 189, 248, 0.6)', // Glowing neon shadow
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 10,
  },
  addButton: { padding: 15, borderRadius: 10, alignItems: 'center', marginBottom: 20 },
  addButtonText: { color: '#ffffff', fontSize: 15, fontWeight: 'bold' },
  card: { backgroundColor: '#121826', padding: 16, borderRadius: 12, marginBottom: 12, borderWidth: 1, borderColor: '#1e293b', flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  cardInfo: { flex: 1, marginRight: 10},
  cardTitle: { fontSize: 15, fontWeight: 'bold', color: '#f8fafc' },
  cardSubtitle: { color: '#64748b', fontSize: 12 },
  deleteButton: {
    padding: 10,
    backgroundColor: 'rgba(239, 68, 68, 0.1)',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(239, 68, 68, 0.2)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  deleteButtonText: { fontSize: 16 },
  emptyText: { textAlign: 'center', color: '#64748b', marginTop: 20, fontStyle: 'italic' },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 20,
  },
  modalContent: {
    backgroundColor: '#121826',
    borderRadius: 16,
    padding: 24,
    width: '100%',
    borderWidth: 1,
    borderColor: '#1e293b',
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#f8fafc',
    marginBottom: 8,
  },
  modalSubtitle: {
    fontSize: 14,
    color: '#94a3b8',
    marginBottom: 16,
  },
  input: {
    backgroundColor: '#0f172a',
    borderWidth: 1,
    borderColor: '#334155',
    borderRadius: 8,
    color: '#f8fafc',
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    marginBottom: 20,
  },
  modalButtons: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
  },
  modalButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  cancelButton: {
    backgroundColor: '#1e293b',
  },
  cancelButtonText: {
    color: '#94a3b8',
    fontWeight: '600',
    fontSize: 15,
  },
  confirmButton: {
    backgroundColor: '#2563eb',
  },
  confirmButtonText: {
    color: '#ffffff',
    fontWeight: '600',
    fontSize: 15,
  }
});