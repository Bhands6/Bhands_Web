import apiClient from './client';
import { SongItem } from './music';

export interface WeatherMood {
  key: string;
  title: string;
  tagline: string;
  energy: number;
  warmth: number;
  focus: number;
  melancholy: number;
  keywords: string[];
}

export interface WeatherInfo {
  provider: 'open-meteo';
  location: {
    name: string;
    country: string;
    admin1: string;
    latitude: number | null;
    longitude: number | null;
    timezone: string;
    fallback?: boolean;
  };
  label: string;
  weatherCode: number | null;
  temperature: number | null;
  apparentTemperature: number | null;
  humidity: number | null;
  precipitation: number | null;
  cloudCover: number | null;
  windSpeed: number | null;
  windGusts: number | null;
  isDay: number | null;
  time: string;
  updatedAt: number;
  mood: WeatherMood;
}

export interface WeatherRadioData {
  weather: WeatherInfo;
  mood: WeatherMood;
  songs: SongItem[];
}

interface ApiResponse<T> {
  success: boolean;
  data: T;
  message?: string;
}

export const weatherApi = {
  async getCurrent(city: string): Promise<ApiResponse<WeatherInfo>> {
    return apiClient.get('/weather/current', { params: { city } });
  },

  async getRadio(city: string): Promise<ApiResponse<WeatherRadioData>> {
    return apiClient.get('/weather/radio', { params: { city } });
  }
};
