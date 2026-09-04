#include "audio_network.h"
#include "sequencer.h"
#include <algorithm>
#include <atomic>
#include <cmath>
#include <cctype>
#include <queue>
#include <unordered_map>

namespace mlh {

void AudioExecutionPlan::SourceDelay::prepare(int delaySamples, int maxBlockSize)
{
    samples = std::max(0, delaySamples);
    cursor = 0;
    if (samples > 0)
    {
        left.assign(static_cast<size_t>(samples + 1), 0.0f);
        right.assign(static_cast<size_t>(samples + 1), 0.0f);
        output.setSize(2, maxBlockSize, false, true, false);
        output.clear();
    }
}

const juce::AudioBuffer<float>& AudioExecutionPlan::SourceDelay::process(
    const juce::AudioBuffer<float>& input, int numSamples) noexcept
{
    if (samples <= 0)
        return input;
    const auto size = left.size();
    for (int sample = 0; sample < numSamples; ++sample)
    {
        left[cursor] = input.getSample(0, sample);
        right[cursor] = input.getSample(1, sample);
        const auto read = (cursor + 1u) % size;
        output.setSample(0, sample, left[read]);
        output.setSample(1, sample, right[read]);
        cursor = read;
    }
    return output;
}

std::unique_ptr<AudioExecutionPlan> AudioExecutionPlan::compile(
    const AudioNetworkSpec& spec, const std::function<Chain*(const std::string&)>& chainLookup,
    SequencerEngine* sequencer, int maxBlockSize, std::string& error,
    bool pdcEnabled)
{
    if (maxBlockSize <= 0) { error = "invalid block size"; return {}; }
    std::unordered_map<std::string, int> index;
    for (int i=0;i<(int)spec.nodes.size();++i) {
        const auto& n=spec.nodes[(size_t)i];
        const bool validId=!n.id.empty()&&std::all_of(n.id.begin(),n.id.end(),[](unsigned char c){return std::isalnum(c)||c=='-'||c=='_';});
        if (!validId || !index.emplace(n.id,i).second) { error="invalid or duplicate node id"; return {}; }
        if (n.kind==AudioNodeKind::vst && chainLookup(n.id)==nullptr) { error="unknown VST node: "+n.id; return {}; }
        if (n.kind==AudioNodeKind::input && n.id!="audio-input") { error="invalid input node id"; return {}; }
        if (n.kind==AudioNodeKind::output && n.id!="audio-output") { error="invalid output node id"; return {}; }
        if (n.kind==AudioNodeKind::morpher && !(n.stepCount==4||n.stepCount==8||n.stepCount==16||n.stepCount==32)) { error="invalid Morpher step count"; return {}; }
    }
    std::vector<int> indegree(spec.nodes.size()); std::vector<std::vector<int>> downstream(spec.nodes.size());
    for (int d=0;d<(int)spec.nodes.size();++d) for (const auto& in:spec.nodes[(size_t)d].inputs) {
        const auto kind=spec.nodes[(size_t)d].kind;
        const bool validPort=(kind==AudioNodeKind::vst||kind==AudioNodeKind::sequencer||kind==AudioNodeKind::output)
            ? in.portId=="audio-in"
            : (kind==AudioNodeKind::mixer||kind==AudioNodeKind::morpher) && in.portId.rfind("audio-in-",0)==0;
        if(!validPort){error="invalid audio input port: "+in.portId;return{};}
        if(in.sourcePortId!="audio-out"){error="invalid audio source port: "+in.sourcePortId;return{};}
        auto found=index.find(in.sourceNodeId); if(found==index.end()){error="unknown audio source: "+in.sourceNodeId;return{};}
        if(spec.nodes[(size_t)found->second].kind==AudioNodeKind::output){error="Audio Output cannot be a source";return{};}
        if(found->second==d){error="audio cycle";return{};} downstream[(size_t)found->second].push_back(d); ++indegree[(size_t)d];
    }
    std::priority_queue<int,std::vector<int>,std::greater<int>> ready;
    for(int i=0;i<(int)indegree.size();++i) if(indegree[(size_t)i]==0) ready.push(i);
    std::vector<int> order; while(!ready.empty()){int i=ready.top();ready.pop();order.push_back(i);for(int d:downstream[(size_t)i])if(--indegree[(size_t)d]==0)ready.push(d);}
    if(order.size()!=spec.nodes.size()){error="audio cycle";return{};}
    static std::atomic<uint32_t> nextPlanIdentity { 1 };
    auto plan=std::make_unique<AudioExecutionPlan>(); plan->maxBlockSize_=maxBlockSize;plan->sequencer_=sequencer;
    plan->blockIdentity_=static_cast<uint64_t>(nextPlanIdentity.fetch_add(1,std::memory_order_relaxed))<<32;
    std::unordered_map<int,int> compiled;
    for(int original:order){const auto& s=spec.nodes[(size_t)original];Node n;n.id=s.id;n.kind=s.kind;n.setMasterLevel(s.masterLevel);n.stepCount=s.stepCount;for(size_t stepIndex=0;stepIndex<NodeValues::kMaxSteps;++stepIndex)n.setStep(stepIndex,s.steps[stepIndex]);n.diagnosticCyclesPerSample=s.diagnosticCyclesPerSample;n.diagnosticAmplitude=std::clamp(s.diagnosticAmplitude,-2.0f,2.0f);n.diagnosticStartSample=std::max<int64_t>(0,s.diagnosticStartSample);n.diagnosticEndSample=std::max(n.diagnosticStartSample,s.diagnosticEndSample);
        if(n.kind==AudioNodeKind::vst)n.chain=chainLookup(n.id);
        if(n.kind==AudioNodeKind::sequencer)n.sequencer=sequencer;
        if(n.kind==AudioNodeKind::mixer||n.kind==AudioNodeKind::morpher)n.signalMeter=std::make_unique<AudioSignalMeter>();
        int maximumSourceLatency=0;
        if(s.inputs.size()>NodeValues::kMaxInputs){error="too many audio inputs at node: "+n.id;return{};}
        for(const auto& in:s.inputs){const int source=compiled.at(index.at(in.sourceNodeId));const size_t inputIndex=n.sources.size();n.sources.push_back(source);n.setLevel(inputIndex,in.level);n.setMuted(inputIndex,in.muted);maximumSourceLatency=std::max(maximumSourceLatency,plan->nodes_[(size_t)source].latencySamples);}
        const int intrinsicLatency=n.kind==AudioNodeKind::vst&&n.chain?n.chain->latencySamples():(n.kind==AudioNodeKind::diagnosticSine?std::clamp(s.diagnosticLatencySamples,0,131072):0);
        n.latencySamples=maximumSourceLatency+intrinsicLatency;
        if(n.latencySamples>131072){error="PDC latency exceeds 131072 samples at node: "+n.id;return{};}
        for(int source:n.sources){SourceDelay delay;delay.prepare(pdcEnabled?maximumSourceLatency-plan->nodes_[(size_t)source].latencySamples:0,maxBlockSize);n.sourceDelays.push_back(std::move(delay));n.processedSources.push_back(nullptr);}
        n.output.setSize(2,maxBlockSize,false,true,false);n.output.clear();n.sequencerInput.setSize(2,maxBlockSize,false,true,false);n.sequencerInput.clear();compiled[original]=(int)plan->nodes_.size();plan->nodes_.push_back(std::move(n));}
    return plan;
}

AudioExecutionPlan::Node* AudioExecutionPlan::findNode(const std::string& id) noexcept
{
    for(auto& node:nodes_) if(node.id==id) return &node;
    return nullptr;
}

float AudioExecutionPlan::morpherPosition(const Node& n,double ppq,int numerator,int denominator) noexcept
{
    const double bar=double(numerator)*4.0/double(std::max(1,denominator));
    double phase=std::fmod(ppq,bar);if(phase<0)phase+=bar;phase/=bar;
    const double scaled=phase*n.stepCount;const int step=std::min(n.stepCount-1,(int)std::floor(scaled));const float f=(float)(scaled-step);
    const float a=n.step((size_t)step),b=n.step((size_t)((step+1)%n.stepCount));
    return a+(b-a)*f;
}

float AudioExecutionPlan::mixScalar(const float* values,const float* levels,const bool* mutes,int count,float master) noexcept
{ float sum=0;for(int i=0;i<count;++i)if(!mutes[i])sum+=values[i]*levels[i];return sum*master; }

std::pair<float,float> AudioExecutionPlan::equalPowerGains(float f) noexcept
{ f=std::clamp(f,0.0f,1.0f);return {std::cos(f*juce::MathConstants<float>::halfPi),std::sin(f*juce::MathConstants<float>::halfPi)}; }

void AudioExecutionPlan::process(float* const* hw,int hwChannels,int count,Transport& transport,juce::MidiBuffer& midi,
                                 const juce::AudioBuffer<float>* hardwareInput) noexcept
{
    if(count>maxBlockSize_)return;
    const uint64_t blockId=blockIdentity_|(++blockCounter_&0xffffffffULL);
    for(auto& n:nodes_){n.output.clear(0,count);
        const bool hasSequencerSource=std::any_of(n.sources.begin(),n.sources.end(),[this](int source){return nodes_[(size_t)source].kind==AudioNodeKind::sequencer;});
        if(hasSequencerSource&&sequencer_){n.sequencerInput.clear(0,count);sequencer_->renderAudioForOutput(n.sequencerInput,count,transport,n.id);}
        for(size_t inputIndex=0;inputIndex<n.sources.size();++inputIndex){const int source=n.sources[inputIndex];const auto& raw=nodes_[(size_t)source].kind==AudioNodeKind::sequencer?n.sequencerInput:nodes_[(size_t)source].output;n.processedSources[inputIndex]=&n.sourceDelays[inputIndex].process(raw,count);}
        const auto& sourceBuffer=[&](size_t inputIndex)->const juce::AudioBuffer<float>&{return *n.processedSources[inputIndex];};
        if(n.kind==AudioNodeKind::diagnosticSine){
            const double twoPi=juce::MathConstants<double>::twoPi;
            for(int sample=0;sample<count;++sample){const int64_t absolute=n.diagnosticRenderedSamples+sample;const float value=absolute>=n.diagnosticStartSample&&absolute<n.diagnosticEndSample?(float)(std::sin(twoPi*n.diagnosticCyclesPerSample*(double)absolute)*n.diagnosticAmplitude):0.0f;for(int ch=0;ch<2;++ch)n.output.setSample(ch,sample,value);}
            n.diagnosticRenderedSamples+=count;
        }
        else if(n.kind==AudioNodeKind::input){
            if(hardwareInput&&hardwareInput->getNumChannels()>0&&hardwareInput->getNumSamples()>=count)
                for(int ch=0;ch<2;++ch)n.output.copyFrom(ch,0,*hardwareInput,std::min(ch,hardwareInput->getNumChannels()-1),0,count);
        }
        else if(n.kind==AudioNodeKind::vst){for(size_t source=0;source<n.sources.size();++source)for(int ch=0;ch<2;++ch)n.output.addFrom(ch,0,sourceBuffer(source),ch,0,count);midi.clear();const auto trackGain=sequencer_?sequencer_->midiTrackGainForOutput(n.id,transport):SequencerEngine::MidiTrackGain{};float peakBeforeGain=0,peakAfterGain=0;n.chain->processBlock(n.output,midi,count,blockId,trackGain.gain,&peakBeforeGain,&peakAfterGain);if(trackGain.controlled&&sequencer_)sequencer_->observeMidiTrackGain(n.id,transport,peakBeforeGain,trackGain.gain,peakAfterGain);}
        else if(n.kind==AudioNodeKind::sequencer){
            // Recording taps exist only at visible, direct AUDIO IN edges.
            // A node elsewhere in the DAG can no longer feed an armed track
            // merely because it happens to be compiled in the same plan.
            if(sequencer_)for(size_t source=0;source<n.sources.size();++source)sequencer_->captureSource(nodes_[(size_t)n.sources[source]].id,sourceBuffer(source),count,transport);
        }
        else if(n.kind==AudioNodeKind::mixer){const float master=n.masterLevel();for(size_t i=0;i<n.sources.size();++i)if(!n.muted(i))for(int ch=0;ch<2;++ch)n.output.addFrom(ch,0,sourceBuffer(i),ch,0,count,n.level(i)*master);if(n.signalMeter){n.signalMeter->observe(n.output,count,AudioSignalBoundary::input);n.signalMeter->observe(n.output,count,AudioSignalBoundary::output);}}
        else if(n.kind==AudioNodeKind::morpher){const size_t total=n.sources.size();if(total==1){for(int ch=0;ch<2;++ch)n.output.copyFrom(ch,0,sourceBuffer(0),ch,0,count);}else if(total>1){const double start=transport.ppqPosition(),delta=transport.processingPlaying()?transport.quarterNotesPerSample():0.0;for(int sample=0;sample<count;++sample){float p=morpherPosition(n,start+delta*sample);float scaled=p*(float)(total-1);size_t left=(size_t)std::floor(scaled),right=std::min(left+1,total-1);float f=scaled-(float)left;auto gains=equalPowerGains(f);for(int ch=0;ch<2;++ch)n.output.setSample(ch,sample,sourceBuffer(left).getSample(ch,sample)*gains.first+(right==left?0.0f:sourceBuffer(right).getSample(ch,sample)*gains.second));}}if(n.signalMeter){n.signalMeter->observe(n.output,count,AudioSignalBoundary::input);n.signalMeter->observe(n.output,count,AudioSignalBoundary::output);}}
        else {
            // Preserve the exact pre-Master Audio Output signal in the node's
            // preallocated buffer. This is both the authoritative final mix
            // tap and a deterministic diagnostic point; no callback-time
            // allocation or copy outside the existing stereo network occurs.
            for(size_t source=0;source<n.sources.size();++source)for(int ch=0;ch<2;++ch)
                n.output.addFrom(ch,0,sourceBuffer(source),ch,0,count);
            for(int ch=0;ch<std::min(2,hwChannels);++ch)
                if(hw[ch])juce::FloatVectorOperations::add(hw[ch],n.output.getReadPointer(ch),count);
        }
    }
}
} // namespace mlh
