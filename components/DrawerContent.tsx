import { View, Text, TouchableOpacity } from 'react-native';
import { DrawerContentScrollView, DrawerContentComponentProps } from '@react-navigation/drawer';
import { Ionicons } from '@expo/vector-icons';

type NavItem = {
  name: string;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  iconActive: keyof typeof Ionicons.glyphMap;
};

const NAV_ITEMS: NavItem[] = [
  { name: 'Home', label: 'Home', icon: 'home-outline', iconActive: 'home' },
  { name: 'Profile', label: 'Profile', icon: 'person-outline', iconActive: 'person' },
  { name: 'KeyMetrics', label: 'Key Metrics', icon: 'bar-chart-outline', iconActive: 'bar-chart' },
];

export default function DrawerContent(props: DrawerContentComponentProps) {
  const { navigation, state } = props;
  const currentRoute = state.routes[state.index].name;

  return (
    <DrawerContentScrollView {...props} contentContainerStyle={{ flex: 1 }}>
      {/* App Header */}
      <View className="px-5 py-8 border-b border-gray-200 bg-blue-600">
        <View className="w-12 h-12 rounded-full bg-white items-center justify-center mb-3">
          <Ionicons name="fitness" size={28} color="#2563eb" />
        </View>
        <Text className="text-xl font-bold text-white">RunTrack</Text>
        <Text className="text-sm text-blue-200 mt-0.5">Your running companion</Text>
      </View>

      {/* Navigation Items */}
      <View className="mt-3 px-2">
        {NAV_ITEMS.map((item) => {
          const isActive = currentRoute === item.name;
          return (
            <TouchableOpacity
              key={item.name}
              className={`flex-row items-center px-4 py-3 rounded-xl mb-1 ${isActive ? 'bg-blue-50' : ''}`}
              onPress={() => navigation.navigate(item.name)}
              activeOpacity={0.7}
            >
              <Ionicons
                name={isActive ? item.iconActive : item.icon}
                size={22}
                color={isActive ? '#2563eb' : '#6b7280'}
              />
              <Text
                className={`ml-3 text-base ${isActive ? 'text-blue-600 font-semibold' : 'text-gray-600 font-normal'}`}
              >
                {item.label}
              </Text>
              {isActive && (
                <View className="ml-auto w-1.5 h-1.5 rounded-full bg-blue-600" />
              )}
            </TouchableOpacity>
          );
        })}
      </View>
    </DrawerContentScrollView>
  );
}
