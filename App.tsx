import './global.css';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { NavigationContainer } from '@react-navigation/native';
import { createDrawerNavigator } from '@react-navigation/drawer';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { StatusBar } from 'expo-status-bar';

import HomeScreen from './screens/HomeScreen';
import ActivityDetailScreen from './screens/ActivityDetailScreen';
import ProfileScreen from './screens/ProfileScreen';
import KeyMetricsScreen from './screens/KeyMetricsScreen';
import DrawerContent from './components/DrawerContent';

export type RootStackParamList = {
  DrawerNav: undefined;
  ActivityDetail: { activityId: number };
};

const RootStack = createNativeStackNavigator<RootStackParamList>();
const Drawer = createDrawerNavigator();

function DrawerNavigator() {
  return (
    <Drawer.Navigator
      drawerContent={(props) => <DrawerContent {...props} />}
      screenOptions={{
        headerStyle: { backgroundColor: '#2563eb' },
        headerTintColor: '#ffffff',
        headerTitleStyle: { fontWeight: '600' },
        drawerType: 'slide',
      }}
    >
      <Drawer.Screen
        name="Home"
        component={HomeScreen}
        options={{ title: 'Dashboard' }}
      />
      <Drawer.Screen
        name="Profile"
        component={ProfileScreen}
        options={{ title: 'Profile' }}
      />
      <Drawer.Screen
        name="KeyMetrics"
        component={KeyMetricsScreen}
        options={{ title: 'Key Metrics' }}
      />
    </Drawer.Navigator>
  );
}

export default function App() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <NavigationContainer>
        <StatusBar style="auto" />
        <RootStack.Navigator>
          <RootStack.Screen
            name="DrawerNav"
            component={DrawerNavigator}
            options={{ headerShown: false }}
          />
          <RootStack.Screen
            name="ActivityDetail"
            component={ActivityDetailScreen}
            options={{
              title: 'Activity',
              headerStyle: { backgroundColor: '#2563eb' },
              headerTintColor: '#ffffff',
              headerTitleStyle: { fontWeight: '600' },
            }}
          />
        </RootStack.Navigator>
      </NavigationContainer>
    </GestureHandlerRootView>
  );
}
