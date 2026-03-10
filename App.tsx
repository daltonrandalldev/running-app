import './global.css';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { StatusBar } from 'expo-status-bar';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import HomeScreen from './screens/HomeScreen';
import ActivityDetailScreen from './screens/ActivityDetailScreen';
import ProfileScreen from './screens/ProfileScreen';
import KeyMetricsScreen from './screens/KeyMetricsScreen';

export type RootStackParamList = {
  MainTabs: undefined;
  KeyMetrics: undefined;
  ActivityDetail: { activityId: string };
};

export type MainTabParamList = {
  Home: undefined;
  Metrics: undefined;
  History: undefined;
  Notifications: undefined;
  Profile: undefined;
};

const RootStack = createNativeStackNavigator<RootStackParamList>();
const Tab = createBottomTabNavigator<MainTabParamList>();

function PlaceholderScreen() {
  return <View style={{ flex: 1, backgroundColor: '#ffffff' }} />;
}

const TAB_ICONS: Record<string, [keyof typeof Ionicons.glyphMap, keyof typeof Ionicons.glyphMap]> = {
  Home: ['home', 'home-outline'],
  Metrics: ['list', 'list-outline'],
  History: ['time', 'time-outline'],
  Notifications: ['notifications', 'notifications-outline'],
  Profile: ['person', 'person-outline'],
};

function TabNavigator() {
  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarShowLabel: false,
        tabBarStyle: {
          backgroundColor: '#ffffff',
          borderTopColor: '#e5e7eb',
          borderTopWidth: 1,
          height: 60,
        },
        tabBarActiveTintColor: '#111827',
        tabBarInactiveTintColor: '#9ca3af',
        tabBarIcon: ({ focused, color }) => {
          const [active, inactive] = TAB_ICONS[route.name] ?? ['ellipse', 'ellipse-outline'];
          return <Ionicons name={focused ? active : inactive} size={24} color={color} />;
        },
      })}
    >
      <Tab.Screen name="Home" component={HomeScreen} />
      <Tab.Screen name="Metrics" component={KeyMetricsScreen} />
      <Tab.Screen name="History" component={PlaceholderScreen} />
      <Tab.Screen name="Notifications" component={PlaceholderScreen} />
      <Tab.Screen name="Profile" component={ProfileScreen} />
    </Tab.Navigator>
  );
}

export default function App() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
      <NavigationContainer>
        <StatusBar style="dark" />
        <RootStack.Navigator>
          <RootStack.Screen
            name="MainTabs"
            component={TabNavigator}
            options={{ headerShown: false }}
          />
          <RootStack.Screen
            name="KeyMetrics"
            component={KeyMetricsScreen}
            options={{ headerShown: false }}
          />
          <RootStack.Screen
            name="ActivityDetail"
            component={ActivityDetailScreen}
            options={{
              title: 'Activity',
              headerStyle: { backgroundColor: '#ffffff' },
              headerTintColor: '#111827',
              headerTitleStyle: { fontWeight: '600' },
            }}
          />
        </RootStack.Navigator>
      </NavigationContainer>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
