// Receipt before acknowledgement makes retries/restarts safe: local game logs
// retain the prompt id, so a network failure cannot apply the same choice twice.
import { acceptedTeamRound } from '../dsh-onboarding/augment-confirmation.mjs';
export async function applyTeamConfirmation({ request, deviceId, facts, binding, room, apply, now = Date.now() }) {
  if (request.sourceDeviceId !== deviceId || request.acknowledged || !['confirmed', 'assumed', 'dismissed'].includes(request.status) || !apply) return null;
  if (!facts || now - facts.at > 30_000 || binding?.roomMatchId !== request.roomMatchId || room.currentMatch?.id !== request.roomMatchId
    || binding.localMatch !== facts.match || binding.game !== facts.game) return 'obsolete';
  const historical = request.status === 'confirmed' ? acceptedTeamRound(facts,request.localConfirmationId,request.choice?.name,now) : null;
  const prior = facts.augmentRounds?.find(round => round.confirmationId === request.localConfirmationId) ?? historical;
  if (request.status === 'confirmed' && prior?.confirmed?.includes(request.choice?.name)) return 'applied';
  if (request.status === 'assumed' && prior?.assumed === request.choice?.name) return 'applied';
  if (prior?.confirmed?.length && prior.confirmationSource !== 'countdown-default-confirmed') return 'conflict';
  if (facts.confirmation?.id !== request.localConfirmationId && !historical) return 'obsolete';
  try {
    await apply({ id: request.localConfirmationId, name: request.choice?.name, dismiss: request.status === 'dismissed', timeoutDefault: request.status === 'assumed', ...(historical?{historical:true}:{}) });
    return 'applied';
  } catch (error) { if (error.status === 409) return 'conflict'; throw error; }
}
