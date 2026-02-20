import { View, Text, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

type CardProps = {
  title: string;
  icon: keyof typeof Ionicons.glyphMap;
  children: React.ReactNode;
};

function Card({ title, icon, children }: CardProps) {
  return (
    <View className="bg-white rounded-2xl p-5 mb-4 shadow-sm border border-gray-100">
      <View className="flex-row items-center mb-4">
        <View className="w-8 h-8 rounded-lg bg-blue-50 items-center justify-center mr-3">
          <Ionicons name={icon} size={18} color="#2563eb" />
        </View>
        <Text className="text-base font-semibold text-gray-800">{title}</Text>
      </View>
      {children}
    </View>
  );
}

type FieldProps = { label: string; placeholder: string };

function Field({ label, placeholder }: FieldProps) {
  return (
    <View className="mb-3 last:mb-0">
      <Text className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">{label}</Text>
      <View className="bg-gray-50 rounded-lg px-3 py-2.5 border border-gray-200">
        <Text className="text-gray-400 text-sm">{placeholder}</Text>
      </View>
    </View>
  );
}

export default function ProfileScreen() {
  return (
    <ScrollView className="flex-1 bg-gray-50">
      <View className="px-5 pt-6 pb-10">
        {/* Avatar placeholder */}
        <View className="items-center mb-6">
          <View className="w-20 h-20 rounded-full bg-blue-100 items-center justify-center border-4 border-white shadow">
            <Ionicons name="person" size={40} color="#93c5fd" />
          </View>
          <Text className="text-lg font-semibold text-gray-800 mt-3">Your Name</Text>
          <Text className="text-sm text-gray-400">Runner</Text>
        </View>

        {/* Name Card */}
        <Card title="Name" icon="person-outline">
          <Field label="First Name" placeholder="e.g. Jane" />
          <Field label="Last Name" placeholder="e.g. Smith" />
          <Field label="Display Name" placeholder="e.g. JaneRuns" />
        </Card>

        {/* Contact Information Card */}
        <Card title="Contact Information" icon="mail-outline">
          <Field label="Email Address" placeholder="you@example.com" />
          <Field label="Phone Number" placeholder="+1 (555) 000-0000" />
        </Card>

        {/* Location Card */}
        <Card title="Location" icon="location-outline">
          <Field label="City" placeholder="e.g. Portland" />
          <Field label="State / Province" placeholder="e.g. Oregon" />
          <Field label="Country" placeholder="e.g. United States" />
        </Card>
      </View>
    </ScrollView>
  );
}
