import { View, Text, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

export default function HomeScreen() {
  return (
    <ScrollView className="flex-1 bg-gray-50">
      <View className="px-5 pt-6 pb-10">
        {/* Welcome Banner */}
        <View className="bg-blue-600 rounded-2xl p-6 mb-6">
          <Text className="text-white text-lg font-medium mb-1">Welcome back!</Text>
          <Text className="text-blue-100 text-sm">Track your runs and hit your goals.</Text>
          <View className="mt-4 flex-row items-center">
            <Ionicons name="trending-up" size={20} color="#bfdbfe" />
            <Text className="text-blue-200 text-sm ml-2">Dashboard coming soon</Text>
          </View>
        </View>

        {/* Quick Stats Placeholder */}
        <Text className="text-base font-semibold text-gray-700 mb-3">Quick Stats</Text>
        <View className="flex-row gap-3 mb-6">
          {[
            { label: 'This Week', value: '— mi', icon: 'map-outline' },
            { label: 'Runs', value: '—', icon: 'footsteps-outline' },
          ].map((stat) => (
            <View key={stat.label} className="flex-1 bg-white rounded-xl p-4 shadow-sm border border-gray-100">
              <Ionicons name={stat.icon as any} size={20} color="#9ca3af" />
              <Text className="text-2xl font-bold text-gray-800 mt-2">{stat.value}</Text>
              <Text className="text-xs text-gray-500 mt-0.5">{stat.label}</Text>
            </View>
          ))}
        </View>

        {/* Recent Activity Placeholder */}
        <Text className="text-base font-semibold text-gray-700 mb-3">Recent Activity</Text>
        <View className="bg-white rounded-xl p-5 shadow-sm border border-gray-100 items-center">
          <Ionicons name="walk-outline" size={36} color="#d1d5db" />
          <Text className="text-gray-400 mt-2 text-sm">No runs logged yet</Text>
        </View>
      </View>
    </ScrollView>
  );
}
