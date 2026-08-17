"use client";

import { useParams } from "next/navigation";
import { InterviewRoom } from "@/components/interview/InterviewRoom";

export default function CandidatePage() {
  const { token } = useParams<{ token: string }>();
  return <InterviewRoom token={token} />;
}
